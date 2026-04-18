/**
 * IIFE demo entry - injects Recorder into any webpage via bookmarklet or script tag.
 * Exposes window.__recorder for manual control in DevTools.
 */
import { PageController } from '@page-agent/page-controller'

import { Recorder } from './Recorder'
import { Replayer } from './Replayer'
import type { RecordedStep } from './types'

declare global {
	interface Window {
		__recorder: Recorder
		__replayer: Replayer
		__recorderSteps: RecordedStep[]
		__replay: (steps?: RecordedStep[]) => Promise<void>
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

console.log(
	'🎙️ Recorder started.\n' +
		'  window.__recorder       — Recorder 实例\n' +
		'  window.__recorderSteps  — 已录制步骤\n' +
		'  window.__recorder.stop() — 停止录制\n' +
		'  window.__replay()       — 回放所有步骤\n' +
		'  window.__replayer.abort() — 中止回放',
)
