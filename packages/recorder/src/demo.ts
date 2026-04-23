/**
 * IIFE demo entry - injects Recorder into any webpage via bookmarklet or script tag.
 * Exposes window.__recorder for manual control in DevTools.
 */
import { PageController } from '@page-agent/page-controller'

import { Recorder } from './Recorder'
import { Replayer } from './Replayer'
import { deleteRecording, getRecording, listRecordings, saveRecording, updateRecording } from './db'
import type { RecordingRecord } from './db'
import type { RecordedStep } from './types'

declare global {
	interface Window {
		__recorder: Recorder
		__replayer: Replayer
		__recorderSteps: RecordedStep[]
		__replay: (steps?: RecordedStep[]) => Promise<void>
		__recordings: {
			save: (name?: string) => Promise<RecordingRecord>
			list: () => Promise<RecordingRecord[]>
			get: (id: string) => Promise<RecordingRecord | undefined>
			update: (id: string, name: string) => Promise<RecordingRecord | undefined>
			delete: (id: string) => Promise<void>
			replay: (id: string) => Promise<void>
		}
	}
}

// Clean up existing instance to allow re-injection
if (window.__recorder) {
	window.__recorder.stop()
}

const controller = new PageController()
const recorder = new Recorder(controller, {
	onStep: (step) => {
		console.log('[recorder]', step.action.type, step)
	},
})

recorder.start()

const replayer = new Replayer(controller, {
	onStepStart: (step, i) => console.log(`[replayer] step ${i + 1}: ${step.action.type}`),
	onStepDone: (step, i, success, msg) =>
		console.log(`[replayer] step ${i + 1} ${success ? '✅' : '❌'}: ${msg}`),
	onDone: () => console.log('[replayer] replay complete'),
})

window.__recorder = recorder
window.__replayer = replayer
window.__recorderSteps = recorder.steps
window.__replay = (steps) => replayer.replay(steps ?? recorder.steps)

window.__recordings = {
	async save(name?: string) {
		const record = await saveRecording({
			name: name ?? `${new URL(window.location.href).hostname} ${new Date().toLocaleString()}`,
			steps: [...recorder.steps],
			startUrl: window.location.href,
		})
		console.log(
			`[recorder] saved recording "${record.name}" (${record.steps.length} steps) id=${record.id}`
		)
		return record
	},
	list: listRecordings,
	get: getRecording,
	update: (id, name) => updateRecording(id, { name }),
	delete: deleteRecording,
	async replay(id: string) {
		const record = await getRecording(id)
		if (!record) {
			console.error(`[recorder] recording ${id} not found`)
			return
		}
		console.log(`[replayer] replaying "${record.name}" (${record.steps.length} steps)`)
		await replayer.replay(record.steps)
	},
}

console.log(
	'🎙️ Recorder started.\n' +
		'  window.__recorder            — Recorder 实例\n' +
		'  window.__recorderSteps       — 已录制步骤（内存）\n' +
		'  window.__recorder.stop()     — 停止录制\n' +
		'  window.__replay()            — 回放内存中的步骤\n' +
		'  window.__replayer.abort()    — 中止回放\n' +
		'\n' +
		'  IndexedDB 存储:\n' +
		'  window.__recordings.save()        — 保存当前录制到 IndexedDB\n' +
		'  window.__recordings.list()        — 列出所有录制\n' +
		'  window.__recordings.replay(id)    — 从 IndexedDB 回放指定录制\n' +
		'  window.__recordings.update(id, name) — 重命名\n' +
		'  window.__recordings.delete(id)    — 删除'
)
