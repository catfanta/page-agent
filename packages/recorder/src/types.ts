export type RecordedActionType =
	| 'click_element_by_index'
	| 'input_text'
	| 'select_dropdown_option'
	| 'navigate'
	| 'scroll'

export interface ClickAction {
	type: 'click_element_by_index'
	index: number
	elementText: string
}

export interface InputAction {
	type: 'input_text'
	index: number
	elementText: string
	text: string
}

export interface SelectAction {
	type: 'select_dropdown_option'
	index: number
	elementText: string
	optionText: string
}

export interface NavigateAction {
	type: 'navigate'
	url: string
}

export interface ScrollAction {
	type: 'scroll'
	down: boolean
	pixels: number
}

export type RecordedAction =
	| ClickAction
	| InputAction
	| SelectAction
	| NavigateAction
	| ScrollAction

export interface RecordedStep {
	action: RecordedAction
	/** Page URL at the time of the action */
	url: string
	/** Timestamp (ms since epoch) */
	timestamp: number
}

export interface RecorderConfig {
	/** Called after every user action is captured */
	onStep?: (step: RecordedStep) => void
	/**
	 * Minimum scroll distance (px) to record as a scroll action.
	 * Filters out accidental tiny scrolls.
	 * @default 50
	 */
	scrollThreshold?: number
}
