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
		this.on(window, 'scroll', this.handleScroll, { passive: true, capture: false } as any)

		// navigation
		this.on(window, 'popstate', this.handleNavigate)
		this.on(window, 'hashchange', this.handleNavigate)

		// intercept pushState / replaceState (SPA navigation)
		this.patchHistory()
	}

	/** Stop listening and clean up all event listeners. */
	stop(): void {
		for (const { target, type, fn, options } of this.listeners) {
			target.removeEventListener(type, fn, options as boolean)
		}
		this.listeners = []
		this.unpatchHistory()
		if (this.scrollDebounceTimer !== null) {
			clearTimeout(this.scrollDebounceTimer)
			this.scrollDebounceTimer = null
		}
		this.pageController.cleanUpHighlights()
	}

	/**
	 * Call this before PageAgent executes a synthetic action,
	 * and setAgentActing(false) after — prevents recording agent actions.
	 */
	setAgentActing(value: boolean): void {
		this.agentActing = value
	}

	// ─── Private handlers ────────────────────────────────────────────────────

	private async resolveElement(
		el: HTMLElement,
	): Promise<{ index: number; elementText: string; elementHint: string } | undefined> {
		await this.pageController.updateTree()
		const index = this.pageController.findIndexByElement(el)
		if (index === undefined) return undefined
		return {
			index,
			elementText: this.pageController.getElementTextSnapshot().get(index) ?? '',
			elementHint: this.getElementHint(el),
		}
	}

	private handleClick = async (e: Event): Promise<void> => {
		if (this.agentActing) return
		if (!(e.target instanceof HTMLElement)) return

		const resolved = await this.resolveElement(e.target)
		if (!resolved) return

		const action: ClickAction = { type: 'click_element_by_index', ...resolved }
		this.pushStep(action)
	}

	private handleChange = async (e: Event): Promise<void> => {
		if (this.agentActing) return
		if (!(e.target instanceof HTMLElement)) return

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

	private handleNavigate = (): void => {
		if (this.agentActing) return
		this.pushStep({ type: 'navigate', url: window.location.href })
	}

	// ─── History patch (SPA pushState/replaceState) ───────────────────────────

	private originalPushState: History['pushState'] | null = null
	private originalReplaceState: History['replaceState'] | null = null

	private patchHistory(): void {
		this.originalPushState = history.pushState.bind(history)
		this.originalReplaceState = history.replaceState.bind(history)

		history.pushState = (...args: Parameters<History['pushState']>) => {
			this.originalPushState!(...args)
			if (!this.agentActing) {
				this.pushStep({ type: 'navigate', url: window.location.href })
			}
		}

		history.replaceState = (...args: Parameters<History['replaceState']>) => {
			this.originalReplaceState!(...args)
			if (!this.agentActing) {
				this.pushStep({ type: 'navigate', url: window.location.href })
			}
		}
	}

	private unpatchHistory(): void {
		if (this.originalPushState) history.pushState = this.originalPushState
		if (this.originalReplaceState) history.replaceState = this.originalReplaceState
		this.originalPushState = null
		this.originalReplaceState = null
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

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
	}
}
