import type { Recorder, Recording, RecordingStore, Replayer } from '@page-agent/recorder'

import type { I18n } from '../i18n'

import './RecordingTab.css'

export interface RecordingTabDeps {
	recorder: Recorder
	replayer: Replayer
	store: RecordingStore
	i18n: I18n
}

/**
 * RecordingTab manages the DOM for the "Recording" tab content.
 * It owns no state beyond what it renders — state lives in Recorder/Replayer/Store.
 */
export class RecordingTab {
	private deps: RecordingTabDeps
	private root: HTMLElement
	private controlsEl!: HTMLElement
	private previewEl!: HTMLElement
	private historyEl!: HTMLElement
	private statusEl!: HTMLElement

	constructor(deps: RecordingTabDeps) {
		this.deps = deps
		this.root = document.createElement('div')
		this.root.className = 'pa-recording-tab'
		this.buildDOM()
		this.wireEvents()
	}

	get element(): HTMLElement {
		return this.root
	}

	/** Call when tab becomes visible to refresh saved recordings list */
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

		this.controlsEl = this.root.querySelector('.pa-rec-controls')!
		this.statusEl = this.root.querySelector('.pa-rec-status')!
		this.previewEl = this.root.querySelector('.pa-rec-preview')!
		this.historyEl = this.root.querySelector('.pa-rec-history-list')!
	}

	private wireEvents(): void {
		const { replayer, i18n } = this.deps

		replayer.on('step:failed', ({ index, reason }) => {
			this.statusEl.textContent = i18n.t('ui.recording.replayFailed', {
				step: String(index + 1),
				reason,
			})
		})
		replayer.on('replay:done', () => {
			this.statusEl.textContent = i18n.t('ui.recording.replayDone')
		})
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
			const actions = this.deps.recorder.recordedActions
			previewList.innerHTML = actions
				.map((a, i) => {
					const desc =
						'elementDesc' in a
							? a.elementDesc
							: 'url' in a
								? a.url
								: `scroll ${a.down ? '↓' : '↑'} ${a.pixels}px`
					return `<div class="pa-rec-action-row">[${i}] ${a.type} &nbsp;<span class="pa-rec-action-desc">${desc}</span></div>`
				})
				.join('')
		}, 500)
	}

	stopLivePreview(): void {
		if (this.livePreviewTimer) {
			clearInterval(this.livePreviewTimer)
			this.livePreviewTimer = null
		}
	}

	async renderHistory(): Promise<void> {
		const { store, replayer, i18n } = this.deps
		const recordings = await store.list()

		if (recordings.length === 0) {
			this.historyEl.innerHTML = `<div class="pa-rec-empty">${i18n.t('ui.recording.noRecordings')}</div>`
			return
		}

		this.historyEl.innerHTML = recordings
			.map((r) => {
				const date = new Date(r.createdAt).toLocaleDateString()
				return `
					<div class="pa-rec-item" data-id="${r.id}">
						<span class="pa-rec-item-name">${r.name}</span>
						<span class="pa-rec-item-date">${date}</span>
						<button class="pa-rec-btn pa-rec-play" data-id="${r.id}" title="${i18n.t('ui.recording.replay')}">▶</button>
						<button class="pa-rec-btn pa-rec-del" data-id="${r.id}" title="${i18n.t('ui.recording.delete')}">🗑</button>
					</div>
				`
			})
			.join('')

		// Wire play buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-play').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id!
				const recording = await store.get(id)
				if (!recording) return
				this.statusEl.textContent = ''
				await replayer.replay(recording)
			})
		})

		// Wire delete buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-del').forEach((btn) => {
			btn.addEventListener('click', async () => {
				if (!confirm(i18n.t('ui.recording.confirmDelete'))) return
				await store.delete(btn.dataset.id!)
				await this.renderHistory()
			})
		})
	}
}
