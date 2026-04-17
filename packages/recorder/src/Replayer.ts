import type { InteractiveElementDomNode } from '@page-agent/page-controller'
import type { PageController } from '@page-agent/page-controller'

import type { ActionRecord, Recording } from './types'
import { computeElementXpath } from './utils'

interface ReplayerEventMap {
	'step:start': { index: number; action: ActionRecord }
	'step:done': { index: number; action: ActionRecord }
	'step:failed': { index: number; action: ActionRecord; reason: string }
	'replay:done': Record<string, never>
}

type Listener<K extends keyof ReplayerEventMap> = (data: ReplayerEventMap[K]) => void

/**
 * Replayer takes a Recording and executes each ActionRecord via PageController.
 * Element lookup: exact xpath match first, then fuzzy score ≥ 0.8 fallback.
 * On failure to locate an element, emits 'step:failed' and stops replay.
 */
export class Replayer {
	private controller: PageController
	private listeners = new Map<string, Set<Listener<any>>>()
	private aborted = false

	constructor(controller: PageController) {
		this.controller = controller
	}

	on<K extends keyof ReplayerEventMap>(event: K, listener: Listener<K>): this {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set())
		this.listeners.get(event)!.add(listener as Listener<any>)
		return this
	}

	off<K extends keyof ReplayerEventMap>(event: K, listener: Listener<K>): this {
		this.listeners.get(event)?.delete(listener as Listener<any>)
		return this
	}

	/** Stop an in-progress replay and immediately clear DOM highlights. */
	abort(): void {
		this.aborted = true
		this.clearHighlight()
	}

	/** Remove all DOM annotation highlights created by updateTree(). */
	clearHighlight(): void {
		void this.controller.cleanUpHighlights()
	}

	async replay(recording: Recording): Promise<void> {
		this.aborted = false

		for (let i = 0; i < recording.actions.length; i++) {
			if (this.aborted) break

			const action = recording.actions[i]
			this.emit('step:start', { index: i, action })

			// navigate: just wait for DOM to settle (SPA route change already happened during recording)
			if (action.type === 'navigate') {
				await this.waitForDomSettle()
				this.emit('step:done', { index: i, action })
				continue
			}

			// Page-level scroll has no xpath and needs no element lookup
			if (action.type === 'scroll' && !action.xpath) {
				await this.executeAction(undefined, action)
				await this.waitForDomSettle()
				this.emit('step:done', { index: i, action })
				continue
			}

			await this.controller.updateTree()

			const xpath = 'xpath' in action ? action.xpath : undefined
			let index = xpath !== undefined ? this.findByXpath(xpath) : undefined
			if (index === undefined) {
				index = this.fuzzyMatch(action)
			}

			if (index === undefined) {
				await this.controller.cleanUpHighlights()
				this.emit('step:failed', {
					index: i,
					action,
					reason: `Element not found: ${xpath ?? JSON.stringify(action)}`,
				})
				return
			}

			await this.executeAction(index, action)
			await this.waitForDomSettle()
			this.emit('step:done', { index: i, action })
		}

		await this.controller.cleanUpHighlights()
		this.emit('replay:done', {})
	}

	private findByXpath(xpath: string): number | undefined {
		// Pass 1: node.xpath set by domTree (when xpath is enabled)
		for (const [index, node] of this.controller.getSelectorMap()) {
			if ((node as InteractiveElementDomNode).xpath === xpath) return index
		}
		// Pass 2: domTree currently omits xpath — compute from live DOM ref
		for (const [index, node] of this.controller.getSelectorMap()) {
			const el = (node as InteractiveElementDomNode).ref as HTMLElement
			if (el && computeElementXpath(el) === xpath) return index
		}
		return undefined
	}

	private fuzzyMatch(action: ActionRecord): number | undefined {
		if (!('elementDesc' in action)) return undefined
		const desc = action.elementDesc

		// Parse elementDesc: "tagName[aria-label=hint] \"text\""
		const tagName = desc.split(/[[\s"]/)[0]?.toLowerCase() ?? ''
		const ariaMatch = /\[aria-label=([^\]]*)\]/.exec(desc)
		const aria = ariaMatch?.[1]?.toLowerCase().trim() ?? ''
		const textMatch = /"([^"]*)"/.exec(desc)
		const text = textMatch?.[1]?.toLowerCase().trim() ?? ''

		let bestScore = 0
		let bestIndex: number | undefined
		// Tracks elements matching tagName + text, used for unique-text fallback
		const textMatchCandidates: number[] = []

		for (const [index, node] of this.controller.getSelectorMap()) {
			const el = (node as InteractiveElementDomNode).ref as HTMLElement
			let score = 0

			const nodeTagName = (node as InteractiveElementDomNode).tagName?.toLowerCase()
			const tagMatches = nodeTagName === tagName
			if (tagMatches) score += 0.3

			const elText = el.textContent?.trim().toLowerCase() ?? ''
			const textMatches = text.length > 0 && elText.includes(text)
			if (textMatches) score += 0.4

			const elAria = el.getAttribute('aria-label')?.toLowerCase().trim() ?? ''
			if (aria && elAria === aria) score += 0.4

			// placeholder is stored under the aria-label key in elementDesc when no aria-label exists
			const elPlaceholder = (el as HTMLInputElement).placeholder?.toLowerCase().trim() ?? ''
			if (aria && elPlaceholder === aria) score += 0.4

			const elRole = el.getAttribute('role')?.toLowerCase() ?? ''
			if (tagName && elRole === tagName) score += 0.1

			if (score >= 0.8 && score > bestScore) {
				bestScore = score
				bestIndex = index
			}

			if (tagMatches && textMatches && text.length >= 5) {
				textMatchCandidates.push(index)
			}
		}

		// Unique-text fallback: a text ≥ 5 chars appearing in exactly one interactive
		// element of the correct tagName is unambiguous even if score < 0.8.
		if (bestIndex === undefined && textMatchCandidates.length === 1) {
			return textMatchCandidates[0]
		}

		return bestIndex
	}

	private async executeAction(index: number | undefined, action: ActionRecord): Promise<void> {
		switch (action.type) {
			case 'click':
				await this.controller.clickElement(index!)
				break
			case 'input':
				await this.controller.inputText(index!, action.text)
				break
			case 'select':
				await this.controller.selectOption(index!, action.option)
				break
			case 'scroll': {
				const scrollIndex = action.xpath ? this.findByXpath(action.xpath) : undefined
				await this.controller.scroll({
					down: action.down,
					numPages: 0,
					pixels: action.pixels,
					index: scrollIndex,
				})
				break
			}
		}
	}

	/**
	 * Wait for DOM to stop mutating (300ms silence) or hard cap at 3s.
	 */
	private waitForDomSettle(): Promise<void> {
		return new Promise((resolve) => {
			let silenceTimer: ReturnType<typeof setTimeout>
			const hardCapTimer = setTimeout(done, 3000)

			const observer = new MutationObserver(() => {
				clearTimeout(silenceTimer)
				silenceTimer = setTimeout(done, 300)
			})

			function done() {
				clearTimeout(silenceTimer)
				clearTimeout(hardCapTimer)
				observer.disconnect()
				resolve()
			}

			observer.observe(document.body, { childList: true, subtree: true, attributes: true })
			// Resolve immediately if there are no mutations at all
			silenceTimer = setTimeout(done, 300)
		})
	}

	private emit<K extends keyof ReplayerEventMap>(event: K, data: ReplayerEventMap[K]): void {
		this.listeners.get(event)?.forEach((fn) => fn(data))
	}
}
