import type { InteractiveElementDomNode } from '@page-agent/page-controller'
import type { PageController } from '@page-agent/page-controller'

import type { ActionRecord, Recording } from './types'
import { computeElementXpath } from './utils'

/**
 * Recorder listens to native user events and converts them to ActionRecords.
 * Call start() to begin, stop() to end and retrieve the Recording.
 * Does NOT persist — caller is responsible for saving via RecordingStore.
 */
export class Recorder {
	private controller: PageController
	private xpathMap = new Map<HTMLElement, string>()
	private descMap = new Map<HTMLElement, string>()
	private actions: ActionRecord[] = []
	private active = false
	private startTime = 0
	/** Shared promise so concurrent callers await the same in-flight refresh */
	private refreshPromise: Promise<void> | null = null
	private lastScrollPixels = new Map<string, number>()

	constructor(controller: PageController) {
		this.controller = controller
	}

	async start(): Promise<void> {
		if (this.active) return
		this.active = true
		this.actions = []
		this.startTime = Date.now()

		await this.refreshIndex()

		document.addEventListener('click', this.onUserClick, { capture: true })
		document.addEventListener('change', this.onUserChange, { capture: true })
		document.addEventListener('scroll', this.onUserScroll, { capture: true, passive: true })
		window.addEventListener('popstate', this.onNavigate)
		window.addEventListener('hashchange', this.onNavigate)

		const nav = (window as any).navigation
		if (nav?.addEventListener) nav.addEventListener('navigate', this.onNavigate)
	}

	stop(): Recording {
		if (!this.active) {
			throw new Error('Recorder is not active. Call start() first.')
		}
		this.active = false

		document.removeEventListener('click', this.onUserClick, { capture: true })
		document.removeEventListener('change', this.onUserChange, { capture: true })
		document.removeEventListener('scroll', this.onUserScroll, { capture: true })
		window.removeEventListener('popstate', this.onNavigate)
		window.removeEventListener('hashchange', this.onNavigate)

		const nav = (window as any).navigation
		if (nav?.removeEventListener) nav.removeEventListener('navigate', this.onNavigate)

		this.xpathMap.clear()
		this.descMap.clear()
		this.lastScrollPixels.clear()

		return {
			id: crypto.randomUUID(),
			name: document.title || 'Recording',
			url: window.location.href,
			createdAt: this.startTime,
			actions: [...this.actions],
		}
	}

	get isActive(): boolean {
		return this.active
	}

	/** Snapshot of current recorded actions (read-only). */
	get recordedActions(): readonly ActionRecord[] {
		return this.actions
	}

	private refreshIndex(): Promise<void> {
		// If a refresh is already in-flight, return the same promise so all
		// callers await the same operation rather than silently skipping.
		if (this.refreshPromise) return this.refreshPromise

		this.refreshPromise = (async () => {
			try {
				await this.controller.updateTree()
				this.xpathMap.clear()
				this.descMap.clear()

				for (const [, node] of this.controller.getSelectorMap()) {
					const el = (node as InteractiveElementDomNode).ref as HTMLElement
					if (!el) continue

					// domTree intentionally omits xpath; compute it from the DOM ref instead
					const xpath = (node as InteractiveElementDomNode).xpath ?? computeElementXpath(el)

					this.xpathMap.set(el, xpath)

					const text = el.textContent?.trim().slice(0, 40) ?? ''
					const aria = el.getAttribute('aria-label') ?? ''
					const placeholder = (el as HTMLInputElement).placeholder ?? ''
					const hint = aria || placeholder
					const tagName = (node as InteractiveElementDomNode).tagName ?? el.tagName.toLowerCase()
					this.descMap.set(el, `${tagName}${hint ? `[aria-label=${hint}]` : ''} "${text}"`)
				}
			} finally {
				this.refreshPromise = null
			}
		})()

		return this.refreshPromise
	}

	private findXpath(el: HTMLElement): { xpath: string; desc: string } | undefined {
		let current: HTMLElement | null = el
		while (current) {
			const xpath = this.xpathMap.get(current)
			if (xpath !== undefined) {
				return { xpath, desc: this.descMap.get(current) ?? xpath }
			}
			current = current.parentElement
		}
		return undefined
	}

	private onUserClick = async (e: MouseEvent): Promise<void> => {
		if (!this.active) return
		const target = e.target as HTMLElement
		let found = this.findXpath(target)

		if (!found) {
			// Element not in index yet — DOM may have changed (e.g. a form just appeared).
			// Refresh and try once more so this click and subsequent inputs are captured.
			await this.refreshIndex()
			found = this.findXpath(target)
		}

		if (!found) return

		this.actions.push({ type: 'click', xpath: found.xpath, elementDesc: found.desc })
		await this.refreshIndex()
	}

	private onUserChange = async (e: Event): Promise<void> => {
		if (!this.active) return
		const el = e.target as HTMLElement
		let found = this.findXpath(el)

		if (!found) {
			// Index may be stale relative to the current DOM — refresh and retry.
			await this.refreshIndex()
			found = this.findXpath(el)
		}

		if (!found) return

		if (el instanceof HTMLSelectElement) {
			const option = el.options[el.selectedIndex]?.text ?? ''
			this.actions.push({ type: 'select', xpath: found.xpath, elementDesc: found.desc, option })
		} else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			this.actions.push({
				type: 'input',
				xpath: found.xpath,
				elementDesc: found.desc,
				text: el.value,
			})
		}

		await this.refreshIndex()
	}

	private onUserScroll = (e: Event): void => {
		if (!this.active) return
		const el = e.target as HTMLElement | Document
		const isPage = el === document || el === document.documentElement || el === document.body
		const pixels = isPage ? window.scrollY : (el as HTMLElement).scrollTop
		const found = isPage ? undefined : this.findXpath(el as HTMLElement)
		const xpath = found?.xpath

		// Collapse consecutive scroll records to the same target
		const last = this.actions[this.actions.length - 1]
		if (last?.type === 'scroll' && last.xpath === xpath) {
			last.pixels = pixels
			last.down = pixels >= (this.lastScrollPixels.get(xpath ?? '__page__') ?? 0)
		} else {
			const prevPixels = this.lastScrollPixels.get(xpath ?? '__page__') ?? 0
			this.actions.push({ type: 'scroll', down: pixels >= prevPixels, pixels, xpath })
		}
		this.lastScrollPixels.set(xpath ?? '__page__', pixels)
	}

	private onNavigate = async (): Promise<void> => {
		if (!this.active) return
		this.actions.push({ type: 'navigate', url: window.location.href })
		await this.refreshIndex()
	}
}
