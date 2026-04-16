export type ActionRecord =
	| { type: 'click'; xpath: string; elementDesc: string }
	| { type: 'input'; xpath: string; elementDesc: string; text: string }
	| { type: 'select'; xpath: string; elementDesc: string; option: string }
	| { type: 'scroll'; down: boolean; pixels: number; xpath?: string }
	| { type: 'navigate'; url: string }

export interface Recording {
	id: string
	name: string
	url: string
	createdAt: number
	actions: ActionRecord[]
}
