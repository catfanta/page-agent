import type { RecordedAction, Recorder, RecordingRecord, Replayer } from '@page-agent/recorder'
import {
	deleteRecording,
	getRecording,
	listRecordings,
	updateRecording,
} from '@page-agent/recorder'

import type { I18n } from '../i18n'

import './RecordingTab.css'

export interface RecordingTabDeps {
	recorder: Recorder
	replayer: Replayer
	i18n: I18n
}

/**
 * RecordingTab manages the DOM for the "Recording" tab content.
 * It owns no state beyond what it renders — state lives in Recorder/Replayer/Store.
 */
export class RecordingTab {
	private deps: RecordingTabDeps
	private root: HTMLElement
	private previewEl!: HTMLElement
	private historyEl!: HTMLElement
	private statusEl!: HTMLElement

	constructor(deps: RecordingTabDeps) {
		this.deps = deps
		this.root = document.createElement('div')
		this.root.className = 'pa-recording-tab'
		this.buildDOM()
	}

	get element(): HTMLElement {
		return this.root
	}

	async refresh(): Promise<void> {
		await this.renderHistory()
	}

	private buildDOM(): void {
		this.root.innerHTML = `
			<div class="pa-rec-controls">
				<span class="pa-rec-status"></span>
			</div>
			<div class="pa-rec-preview" style="display:none">
				<div class="pa-rec-preview-list"></div>
			</div>
			<div class="pa-rec-history">
				<div class="pa-rec-history-list"></div>
			</div>
		`

		this.statusEl = this.root.querySelector('.pa-rec-status')!
		this.previewEl = this.root.querySelector('.pa-rec-preview')!
		this.historyEl = this.root.querySelector('.pa-rec-history-list')!
	}

	setRecordingState(recording: boolean): void {
		const { i18n } = this.deps
		if (recording) {
			this.statusEl.textContent = i18n.t('ui.recording.recordingStatus')
			this.previewEl.style.display = 'block'
			this.startLivePreview()
		} else {
			this.statusEl.textContent = ''
			this.previewEl.style.display = 'none'
			this.stopLivePreview()
		}
	}

	private livePreviewTimer: ReturnType<typeof setInterval> | null = null

	startLivePreview(): void {
		const previewList = this.previewEl.querySelector('.pa-rec-preview-list')!
		this.livePreviewTimer = setInterval(() => {
			const steps = this.deps.recorder.steps
			previewList.innerHTML = steps
				.map(
					(s, i) =>
						`<div class="pa-rec-action-row">[${i}] ${s.action.type} &nbsp;<span class="pa-rec-action-desc">${this.actionDesc(s.action)}</span></div>`
				)
				.join('')
		}, 500)
	}

	stopLivePreview(): void {
		if (this.livePreviewTimer) {
			clearInterval(this.livePreviewTimer)
			this.livePreviewTimer = null
		}
	}

	private actionDesc(a: RecordedAction): string {
		switch (a.type) {
			case 'input_text':
				return `${a.elementText}  →  "${a.text}"`
			case 'click_element_by_index':
				return a.elementText || a.elementHint || ''
			case 'select_dropdown_option':
				return `${a.elementText}  →  "${a.optionText}"`
			case 'navigate':
				return a.url
			case 'scroll':
				return `scroll ${a.down ? '↓' : '↑'} ${a.pixels}px`
		}
	}

	async renderHistory(): Promise<void> {
		const { replayer, i18n } = this.deps
		const recordings = await listRecordings()

		if (recordings.length === 0) {
			this.historyEl.innerHTML = `<div class="pa-rec-empty">${i18n.t('ui.recording.noRecordings')}</div>`
			return
		}

		this.historyEl.innerHTML = recordings
			.map((r) => {
				const date = new Date(r.createdAt).toLocaleDateString()
				const safeName = r.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
				return `
					<div class="pa-rec-entry">
						<div class="pa-rec-item" data-id="${r.id}">
							<span class="pa-rec-item-name">${safeName}</span>
							<span class="pa-rec-item-date">${date}</span>
							<button class="pa-rec-btn pa-rec-view" data-id="${r.id}" title="${i18n.t('ui.recording.viewActions')}">☰</button>
							<button class="pa-rec-btn pa-rec-edit" data-id="${r.id}" title="${i18n.t('ui.recording.rename')}">✏️</button>
							<button class="pa-rec-btn pa-rec-play" data-id="${r.id}" title="${i18n.t('ui.recording.replay')}">▶</button>
							<button class="pa-rec-btn pa-rec-del" data-id="${r.id}" title="${i18n.t('ui.recording.delete')}">🗑</button>
						</div>
						<div class="pa-rec-actions-detail"></div>
					</div>
				`
			})
			.join('')

		// Wire view buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-view').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation()
				const id = btn.dataset.id!
				const entry = btn.closest<HTMLElement>('.pa-rec-entry')!
				const detail = entry.querySelector<HTMLElement>('.pa-rec-actions-detail')!
				if (detail.classList.contains('pa-rec-actions-open')) {
					detail.classList.remove('pa-rec-actions-open')
					btn.classList.remove('pa-rec-view-active')
					return
				}
				await this.renderActionDetail(detail, id)
				detail.classList.add('pa-rec-actions-open')
				btn.classList.add('pa-rec-view-active')
			})
		})

		// Wire edit buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-edit').forEach((btn) => {
			btn.addEventListener('click', () => {
				const id = btn.dataset.id!
				const item = btn.closest<HTMLElement>('.pa-rec-item')!
				this.enterRenameMode(item, id)
			})
		})

		// Wire play buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-play').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id!
				const recording = await getRecording(id)
				if (!recording) return
				this.statusEl.textContent = ''
				await replayer.replay(recording.steps)
				this.statusEl.textContent = i18n.t('ui.recording.replayDone')
			})
		})

		// Wire delete buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-del').forEach((btn) => {
			btn.addEventListener('click', async () => {
				if (!confirm(i18n.t('ui.recording.confirmDelete'))) return
				await deleteRecording(btn.dataset.id!)
				await this.renderHistory()
			})
		})
	}

	private async renderActionDetail(detail: HTMLElement, recordingId: string): Promise<void> {
		const recording = await getRecording(recordingId)
		if (!recording || recording.steps.length === 0) {
			detail.innerHTML = `<div class="pa-rec-actions-empty">—</div>`
			return
		}
		detail.innerHTML = recording.steps
			.map(
				(s, i) => `
				<div class="pa-rec-action-row">
					<span class="pa-rec-action-index">${i + 1}</span>
					<span class="pa-rec-action-type">${s.action.type}</span>
					<span class="pa-rec-action-desc">${this.actionDesc(s.action)}</span>
					<button class="pa-rec-btn pa-rec-action-del" data-action-index="${i}" title="Delete this step">✕</button>
				</div>
			`
			)
			.join('')

		detail.querySelectorAll<HTMLButtonElement>('.pa-rec-action-del').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation()
				const idx = Number(btn.dataset.actionIndex)
				const rec = await getRecording(recordingId)
				if (!rec) return
				const newSteps = [...rec.steps]
				newSteps.splice(idx, 1)
				await updateRecording(recordingId, { steps: newSteps })
				await this.renderActionDetail(detail, recordingId)
			})
		})
	}

	private enterRenameMode(item: HTMLElement, id: string): void {
		const { i18n } = this.deps
		const nameSpan = item.querySelector<HTMLElement>('.pa-rec-item-name')!
		const editBtn = item.querySelector<HTMLButtonElement>('.pa-rec-edit')!
		const currentName = nameSpan.textContent ?? ''

		const input = document.createElement('input')
		input.className = 'pa-rec-rename-input'
		input.value = currentName
		nameSpan.replaceWith(input)
		input.focus()
		input.select()

		const saveBtn = document.createElement('button')
		saveBtn.className = 'pa-rec-btn pa-rec-rename-save'
		saveBtn.title = i18n.t('ui.recording.renameSave')
		saveBtn.textContent = '✔'

		const cancelBtn = document.createElement('button')
		cancelBtn.className = 'pa-rec-btn pa-rec-rename-cancel'
		cancelBtn.title = i18n.t('ui.recording.renameCancel')
		cancelBtn.textContent = '✖'

		editBtn.replaceWith(saveBtn, cancelBtn)

		const commit = async () => {
			const newName = input.value.trim()
			if (newName && newName !== currentName) {
				await updateRecording(id, { name: newName })
			}
			await this.renderHistory()
		}

		const cancel = () => void this.renderHistory()

		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			void commit()
		})
		cancelBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			cancel()
		})
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault()
				void commit()
			}
			if (e.key === 'Escape') {
				e.preventDefault()
				cancel()
			}
		})
	}
}
