/**
 * Content-script side recorder and replayer.
 * Handles RECORDER_CONTROL and REPLAYER_CONTROL messages from the hub tab
 * (proxied through the background service worker).
 *
 * Both Recorder and Replayer need direct DOM access, so they must run here.
 */
import { PageController } from '@page-agent/page-controller'
import { type RecordedStep, Recorder, Replayer } from '@page-agent/recorder'

const PREFIX = '[Recorder.content]'

let sharedPC: PageController | null = null
let recorder: Recorder | null = null
let replayer: Replayer | null = null
let recordingStartUrl = ''

function getSharedPC(): PageController {
	if (!sharedPC) {
		sharedPC = new PageController({ enableMask: false, viewportExpansion: 400 })
	}
	return sharedPC
}

export function initRecorderContent(): void {
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse): true | undefined => {
		if (message.type === 'RECORDER_CONTROL') {
			handleRecorderMessage(message.action, message.payload ?? {}, sendResponse)
			return true
		}
		if (message.type === 'REPLAYER_CONTROL') {
			handleReplayerMessage(message.action, message.payload ?? {}, sendResponse)
			return true
		}
	})
}

function handleRecorderMessage(
	action: string,
	_payload: Record<string, unknown>,
	sendResponse: (r: unknown) => void
): void {
	switch (action) {
		case 'start': {
			if (recorder) {
				recorder.stop()
				recorder = null
			}
			recordingStartUrl = window.location.href

			recorder = new Recorder(getSharedPC())
			recorder.start()

			console.debug(PREFIX, 'recording started on', recordingStartUrl)
			sendResponse({ success: true, url: recordingStartUrl })
			break
		}

		case 'stop': {
			const steps = recorder ? [...recorder.steps] : []
			recorder?.stop()
			recorder = null
			console.debug(PREFIX, 'recording stopped,', steps.length, 'steps')
			sendResponse({ success: true, steps, startUrl: recordingStartUrl })
			break
		}

		case 'get_steps': {
			sendResponse({
				success: true,
				steps: recorder ? [...recorder.steps] : [],
				startUrl: recordingStartUrl,
			})
			break
		}

		default:
			sendResponse({ success: false, error: `Unknown recorder action: ${action}` })
	}
}

function handleReplayerMessage(
	action: string,
	payload: Record<string, unknown>,
	sendResponse: (r: unknown) => void
): void {
	switch (action) {
		case 'start': {
			if (replayer) {
				replayer.abort()
				replayer = null
			}

			const steps = payload.steps as RecordedStep[]
			if (!steps || !Array.isArray(steps)) {
				sendResponse({ success: false, error: 'steps array required' })
				return
			}

			const stepResults: { index: number; success: boolean; message: string }[] = []
			replayer = new Replayer(getSharedPC(), {
				onStepStart: (_step, i) => {
					console.debug(PREFIX, `replay step ${i + 1}/${steps.length}`, _step.action.type)
				},
				onStepDone: (_step, i, success, message) => {
					stepResults.push({ index: i, success, message })
				},
				onDone: () => {
					replayer = null
					sendResponse({ success: true, stepResults, stepsTotal: steps.length })
				},
			})

			replayer.replay(steps).catch((err: Error) => {
				replayer = null
				sendResponse({ success: false, error: err.message })
			})
			break
		}

		case 'stop': {
			replayer?.abort()
			replayer = null
			sendResponse({ success: true, stopped: true })
			break
		}

		default:
			sendResponse({ success: false, error: `Unknown replayer action: ${action}` })
	}
}
