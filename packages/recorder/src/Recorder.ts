import { PageController } from '@page-agent/page-controller'

import type {
	ClickAction,
	InputAction,
	RecordedAction,
	RecordedStep,
	RecorderConfig,
	SelectAction,
} from './types'

/**
 * Recorder captures real user browser interactions and converts them into
 * a structured action list compatible with the page-agent replay pipeline.
 *
 * It reuses PageController's DOM extraction (updateTree + selectorMap) to
 * identify which indexed element the user interacted with, so recorded
 * actions can be replayed directly via PageAgent tools.
 */
export class Recorder {
	readonly pageController: PageController
	readonly steps: RecordedStep[] = []

	private config: Required<RecorderConfig>
	private listeners: {
		target: EventTarget
		type: string
		fn: EventListener
		options?: boolean | AddEventListenerOptions
	}[] = []

	/**
	 * Flag set to true while PageAgent is executing synthetic events,
	 * so we don't accidentally record agent-driven actions as user actions.
	 */
	private agentActing = false

	/** Tracks last scroll position to calculate delta and direction */
	private lastScrollY = window.scrollY

	/** In-flight async event handler promises — needed to drain them before stop(). */
	private readonly inFlight = new Set<Promise<void>>()

	/**
	 * Pending re-index timers scheduled by pushStep(). Tracked so stop() can
	 * cancel them; otherwise the last interaction's timer fires after stop() and
	 * updateTree() redraws the highlight boxes we just cleaned up.
	 */
	private readonly reindexTimers = new Set<ReturnType<typeof setTimeout>>()

	constructor(pageController: PageController, config: RecorderConfig = {}) {
		this.pageController = pageController
		this.config = {
			onStep: config.onStep ?? (() => {}),
			scrollThreshold: config.scrollThreshold ?? 50,
		}
	}

	/**
	 * Start listening to user interactions.
	 * Safe to call multiple times — subsequent calls are no-ops.
	 */
	start(): void {
		if (this.listeners.length > 0) return

		// click — capture phase so we run before page handlers
		this.on(document, 'click', this.handleClick, true)

		// change fires after the user commits a value (blur from input, select option)
		this.on(document, 'change', this.handleChange, true)

		// scroll — throttled via requestAnimationFrame
		this.on(window, 'scroll', this.handleScroll, { passive: true, capture: false })

		// Pre-populate selectorMap/elementTextMap so the first interaction resolves correctly
		void this.pageController.updateTree()
	}

	/** Stop listening and clean up all event listeners. */
	stop(): void {
		for (const { target, type, fn, options } of this.listeners) {
			target.removeEventListener(type, fn, options as boolean)
		}
		this.listeners = []
		if (this.scrollDebounceTimer !== null) {
			clearTimeout(this.scrollDebounceTimer)
			this.scrollDebounceTimer = null
		}
		// Cancel any pending re-index timers so a late updateTree() doesn't
		// redraw the highlight boxes after we clean them up below.
		for (const timer of this.reindexTimers) clearTimeout(timer)
		this.reindexTimers.clear()
		void this.pageController.cleanUpHighlights()
	}

	/**
	 * Call this before PageAgent executes a synthetic action,
	 * and setAgentActing(false) after — prevents recording agent actions.
	 */
	setAgentActing(value: boolean): void {
		this.agentActing = value
	}

	/**
	 * Wait for all in-flight async handlers (handleClick / handleChange) to settle.
	 * Call this before stop() + steps.slice() to avoid losing the last interaction
	 * when the async fallback path is taken (element not yet in selectorMap).
	 */
	flush(): Promise<void> {
		return Promise.all([...this.inFlight].map((p) => p.catch(() => {}))).then(() => {})
	}

	// ─── Private handlers ────────────────────────────────────────────────────

	/**
	 * Resolves an element to its recorded action payload.
	 * Uses the current selectorMap snapshot first (no I/O); falls back to a full
	 * updateTree() only when the element is not yet indexed. This keeps the common
	 * path synchronous so pushStep() is called before any competing browser task.
	 */
	private async resolveElement(
		el: HTMLElement
	): Promise<{ index: number; elementText: string; elementHint: string } | undefined> {
		const index = this.pageController.findIndexByElement(el)
		if (index !== undefined) {
			return {
				index,
				elementText: this.pageController.getElementTextSnapshot().get(index) ?? '',
				elementHint: this.getElementHint(el),
			}
		}
		await this.pageController.updateTree()
		const retryIndex = this.pageController.findIndexByElement(el)
		if (retryIndex === undefined) return undefined
		return {
			index: retryIndex,
			elementText: this.pageController.getElementTextSnapshot().get(retryIndex) ?? '',
			elementHint: this.getElementHint(el),
		}
	}

	private handleClick = (e: Event): void => {
		this.track(this.doHandleClick(e))
	}

	private doHandleClick = async (e: Event): Promise<void> => {
		if (this.agentActing) return
		if (!(e.target instanceof HTMLElement)) return
		if (this.isIgnored(e.target)) return

		const resolved = await this.resolveElement(e.target)
		if (!resolved) return

		const action: ClickAction = { type: 'click_element_by_index', ...resolved }
		this.pushStep(action)
	}

	private handleChange = (e: Event): void => {
		this.track(this.doHandleChange(e))
	}

	private doHandleChange = async (e: Event): Promise<void> => {
		if (this.agentActing) return
		if (!(e.target instanceof HTMLElement)) return
		if (this.isIgnored(e.target)) return

		const resolved = await this.resolveElement(e.target)
		if (!resolved) return

		const { index, elementText, elementHint } = resolved
		let action: RecordedAction

		if (e.target instanceof HTMLSelectElement) {
			const selected = e.target.options[e.target.selectedIndex]
			const optionText = selected?.textContent?.trim() ?? ''
			action = {
				type: 'select_dropdown_option',
				index,
				elementText,
				elementHint,
				optionText,
			} satisfies SelectAction
		} else if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			action = {
				type: 'input_text',
				index,
				elementText,
				elementHint,
				text: e.target.value,
			} satisfies InputAction
		} else if ((e.target as HTMLElement).isContentEditable) {
			action = {
				type: 'input_text',
				index,
				elementText,
				elementHint,
				text: (e.target as HTMLElement).innerText,
			} satisfies InputAction
		} else {
			return
		}

		this.pushStep(action)
	}

	private track(p: Promise<void>): void {
		this.inFlight.add(p)
		void p.finally(() => this.inFlight.delete(p))
	}

	private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null
	private handleScroll = (): void => {
		if (this.agentActing) return

		if (this.scrollDebounceTimer !== null) {
			clearTimeout(this.scrollDebounceTimer)
		}

		this.scrollDebounceTimer = setTimeout(() => {
			this.scrollDebounceTimer = null
			const delta = window.scrollY - this.lastScrollY
			if (Math.abs(delta) < this.config.scrollThreshold) {
				this.lastScrollY = window.scrollY
				return
			}
			this.pushStep({ type: 'scroll', down: delta > 0, pixels: Math.round(Math.abs(delta)) })
			this.lastScrollY = window.scrollY
		}, 300)
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * Whether an element lives inside UI chrome that must never be recorded
	 * (the agent panel and its overlays). Mirrors the DOM-extraction exclusion
	 * markers so recording stays consistent with what gets indexed.
	 */
	private isIgnored(el: HTMLElement): boolean {
		return el.closest('[data-page-agent-ignore="true"],[data-browser-use-ignore="true"]') !== null
	}

	private getElementHint(el: HTMLElement): string {
		return (
			el.getAttribute('aria-label') ||
			el.getAttribute('title') ||
			(el as HTMLInputElement).placeholder ||
			''
		)
	}

	private on(
		target: EventTarget,
		type: string,
		fn: (e: Event) => void,
		optionsOrCapture?: boolean | AddEventListenerOptions
	): void {
		const bound = fn.bind(this) as EventListener
		target.addEventListener(type, bound, optionsOrCapture as boolean)
		this.listeners.push({ target, type, fn: bound, options: optionsOrCapture })
	}

	private pushStep(action: RecordedAction): void {
		const step: RecordedStep = {
			action,
			url: window.location.href,
			timestamp: Date.now(),
		}
		this.steps.push(step)
		this.config.onStep(step)
		// Re-index after click effects settle (React re-renders, async DOM updates).
		// Tracked so stop() can cancel a pending timer before cleaning highlights.
		const timer = setTimeout(() => {
			this.reindexTimers.delete(timer)
			void this.pageController.updateTree()
		}, 500)
		this.reindexTimers.add(timer)
	}
}
