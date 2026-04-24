import { PageController } from '@page-agent/page-controller'

import type { RecordedStep } from './types'

export interface ReplayerConfig {
	/** Delay between steps in ms (default: 500) */
	stepDelay?: number
	onStepStart?: (step: RecordedStep, index: number) => void
	onStepDone?: (step: RecordedStep, index: number, success: boolean, message: string) => void
	onDone?: (steps: RecordedStep[]) => void
}

export class Replayer {
	private pageController: PageController
	private config: Required<ReplayerConfig>
	private aborted = false

	constructor(pageController: PageController, config: ReplayerConfig = {}) {
		this.pageController = pageController
		this.config = {
			stepDelay: config.stepDelay ?? 500,
			onStepStart: config.onStepStart ?? (() => {}),
			onStepDone: config.onStepDone ?? (() => {}),
			onDone: config.onDone ?? (() => {}),
		}
	}

	abort(): void {
		this.aborted = true
	}

	async replay(steps: RecordedStep[]): Promise<void> {
		this.aborted = false

		for (let i = 0; i < steps.length; i++) {
			if (this.aborted) break

			const step = steps[i]
			this.config.onStepStart(step, i)

			await this.pageController.updateTree()
			const result = await this.executeStep(step)

			this.config.onStepDone(step, i, result.success, result.message)

			if (!result.success) {
				console.warn(`[Replayer] step ${i} failed: ${result.message}`)
			}

			if (i < steps.length - 1) {
				await sleep(this.config.stepDelay)
			}
		}

		await this.pageController.cleanUpHighlights()
		this.config.onDone(steps)
	}

	private static normalizeText(s: string): string {
		return s.replace(/^\[\d+\]/, '').trim()
	}

	private resolveIndex(recordedIndex: number, recordedText: string, elementHint?: string): number {
		const snapshot = this.pageController.getElementTextSnapshot()
		const normalizedRecorded = Replayer.normalizeText(recordedText)

		// normalizeText strips the [N] prefix so index changes don't break matching
		if (normalizedRecorded) {
			for (const [idx, text] of snapshot) {
				if (Replayer.normalizeText(text) === normalizedRecorded) return idx
			}
		}

		if (elementHint) {
			for (const [idx, text] of snapshot) {
				if (text.includes(elementHint)) return idx
			}
		}

		console.warn(
			`[Replayer] element not found (text="${recordedText}", hint="${elementHint ?? ''}"), falling back to recorded index ${recordedIndex}`
		)
		return recordedIndex
	}

	private async executeStep(step: RecordedStep): Promise<{ success: boolean; message: string }> {
		const { action } = step

		switch (action.type) {
			case 'click_element_by_index': {
				const idx = this.resolveIndex(action.index, action.elementText, action.elementHint)
				return this.pageController.clickElement(idx)
			}

			case 'input_text': {
				const idx = this.resolveIndex(action.index, action.elementText, action.elementHint)
				return this.pageController.inputText(idx, action.text)
			}

			case 'select_dropdown_option': {
				const idx = this.resolveIndex(action.index, action.elementText, action.elementHint)
				return this.pageController.selectOption(idx, action.optionText)
			}

			case 'navigate':
				window.location.href = action.url
				return { success: true, message: `Navigated to ${action.url}` }

			case 'scroll':
				return this.pageController.scroll({ down: action.down, numPages: 1, pixels: action.pixels })

			default:
				return { success: false, message: `Unknown action type: ${(action as any).type}` }
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
