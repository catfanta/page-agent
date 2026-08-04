import { PageController } from '@page-agent/page-controller'
import {
	Recorder,
	Replayer,
	getRecording,
	listRecordings,
	saveRecording,
} from '@page-agent/recorder'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { RecordingTab } from './RecordingTab'
import type { RecordingTabDeps } from './RecordingTab'

import styles from '../../ui/src/panel/Panel.module.css'

interface Message {
	id: string
	role: 'user' | 'assistant'
	content: string
	pending?: boolean
	error?: boolean
}

type ServerHealth = 'ok' | 'error' | null

// OpenHuman /health response (openhuman-web).
interface DetailedHealth {
	healthy?: boolean
	degraded?: boolean
	uptime_seconds?: number
	[key: string]: unknown
}

interface HealthState {
	status: ServerHealth
	detail: DetailedHealth | null
}

interface RecordingDeps {
	recorder: Recorder
	replayer: Replayer
}

interface OpenHumanPanelProps {
	/** OpenHuman server base URL, e.g. 'http://localhost:8080'. Falls back to vite proxy when omitted. */
	baseURL?: string
	/** Bearer token for the OpenHuman server (OPENHUMAN_CORE_TOKEN). Falls back to VITE_OPENHUMAN_CORE_TOKEN env var when omitted. */
	apiKey?: string
	/** Optional model id override, forwarded as channel_web_chat's model_override. */
	model?: string
	/** Called when the user closes the panel. */
	onClose?: () => void
	/**
	 * External recording deps. When omitted, OpenHumanPanel creates its own
	 * PageController + Recorder + Replayer automatically.
	 */
	recording?: RecordingDeps
	/**
	 * Initial demo-mode state. When on, the recording/replay commands
	 * (开始录制 / 结束录制 / 回放 [name] / 回放结束) are intercepted locally and
	 * never reach the LLM/server. Falls back to VITE_OPENHUMAN_DEMO_MODE when
	 * omitted. Users can still toggle it at runtime via the 🎬 button.
	 */
	demoMode?: boolean
}

function buildEndpoint(baseURL: string | undefined, path: string): string {
	return baseURL ? `${baseURL}${path}` : `/api/openhuman${path}`
}

interface RpcError {
	code: number
	message: string
}

// Minimal JSON-RPC 2.0 caller for the OpenHuman /rpc endpoint (method B).
async function rpc(
	baseURL: string | undefined,
	apiKey: string | undefined,
	method: string,
	params: unknown,
	signal: AbortSignal,
	id = 1
): Promise<any> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`

	const resp = await fetch(buildEndpoint(baseURL, '/rpc'), {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		signal,
	})
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
	const data = (await resp.json()) as { result?: any; error?: RpcError }
	if (data.error) throw new Error(`RPC ${data.error.code}: ${data.error.message}`)
	return data.result
}

function messageItemClass(msg: Message): string {
	if (msg.role === 'user') return styles.input
	if (msg.error) return styles.error
	if (msg.pending) return styles.observation
	return styles.output
}

// Payload shared by every method-B SSE event.
interface SSEEvent {
	event?: string
	request_id?: string
	delta?: string
	full_response?: string
	message?: string
}

/**
 * Consume the method-B `/events` SSE stream until `chat_done` for our request.
 *
 * The stream carries events for every request on the same client_id, so each
 * event is filtered by `request_id` (the empty string is treated as broadcast).
 * `text_delta` events are the incremental reply; `chat_done.full_response` is
 * the authoritative final text; `chat_error`/`error` surface failures.
 */
async function readMethodBStream(
	resp: Response,
	myRequestId: string,
	assistantId: string,
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>
) {
	const reader = resp.body!.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let full = ''
	let hasContent = false

	const isMine = (p: SSEEvent) => p.request_id === myRequestId || p.request_id === ''

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })

			// SSE events are separated by a blank line. Keep the trailing partial
			// event in the buffer until its terminating blank line arrives.
			const blocks = buffer.split('\n\n')
			buffer = blocks.pop() ?? ''

			let accumulated = ''
			for (const block of blocks) {
				let eventName = ''
				let dataRaw = ''
				for (const line of block.split('\n')) {
					if (line.startsWith('event:')) eventName = line.slice(6).trim()
					else if (line.startsWith('data:')) dataRaw += line.slice(5).trim()
				}
				if (!dataRaw) continue

				let payload: SSEEvent
				try {
					payload = JSON.parse(dataRaw) as SSEEvent
				} catch {
					continue // ignore malformed SSE chunks
				}
				const name = eventName || payload.event
				if (!isMine(payload)) continue

				if (name === 'text_delta') {
					accumulated += payload.delta ?? ''
				} else if (name === 'chat_done') {
					// full_response is authoritative; fall back to accumulated deltas.
					const final = payload.full_response ?? full + accumulated
					setMessages((prev) =>
						prev.map((m) => (m.id === assistantId ? { ...m, content: final, pending: false } : m))
					)
					return
				} else if (name === 'chat_error' || name === 'error') {
					throw new Error(payload.message || 'chat error')
				}
			}

			if (accumulated) {
				full += accumulated
				hasContent = true
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantId ? { ...m, content: m.content + accumulated, pending: false } : m
					)
				)
			}
		}
	} finally {
		reader.releaseLock()
	}

	// Stream ended without chat_done (connection dropped): clear the pending flag.
	if (!hasContent) {
		setMessages((prev) =>
			prev.map((m) => (m.id === assistantId && m.pending ? { ...m, pending: false } : m))
		)
	}
}

const BASE_BUTTON_STYLE: React.CSSProperties = {
	flexShrink: 0,
	height: '28px',
	padding: '0 12px',
	border: 'none',
	borderRadius: '6px',
	fontSize: '12px',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
	background: 'rgba(255,255,255,0.15)',
	color: 'white',
}

const STOP_BUTTON_STYLE: React.CSSProperties = {
	...BASE_BUTTON_STYLE,
	background: 'rgba(239,68,68,0.25)',
	color: 'rgb(255,100,100)',
}

export const OpenHumanPanel: React.FC<OpenHumanPanelProps> = ({
	baseURL: propBaseURL,
	apiKey: propApiKey,
	model: propModel,
	onClose,
	recording,
	demoMode: propDemoMode,
}) => {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [isExpanded, setIsExpanded] = useState(false)
	const [visible, setVisible] = useState(false)
	const [isRecording, setIsRecording] = useState(false)
	const [isRecListExpanded, setIsRecListExpanded] = useState(false)
	// Demo mode: when on, the recording commands (开始录制 / 结束录制 /
	// 回放 [name] / 回放结束) are intercepted locally and never reach the
	// LLM/server. Initial value: explicit prop wins, else VITE_OPENHUMAN_DEMO_MODE.
	const [isDemoMode, setIsDemoMode] = useState(
		propDemoMode ?? ['true', '1'].includes(import.meta.env.VITE_OPENHUMAN_DEMO_MODE ?? '')
	)
	const [health, setHealth] = useState<HealthState>({ status: null, detail: null })
	// Internal deps created when recording prop is not provided
	const [internalDeps, setInternalDeps] = useState<RecordingDeps | null>(null)

	const abortRef = useRef<AbortController | null>(null)
	const historyRef = useRef<HTMLDivElement>(null)
	const recListRef = useRef<HTMLDivElement>(null)
	const recordingTabRef = useRef<RecordingTab | null>(null)
	const sessionStartIndexRef = useRef(0)
	// Method-B session identifiers. client_id ties the SSE subscription to the
	// chat request; thread_id groups turns into one server-side conversation.
	// Lazily initialized on first access to keep render pure; a new conversation
	// regenerates the thread_id (see newConversation).
	const clientIdRef = useRef<string | null>(null)
	const threadIdRef = useRef<string | null>(null)

	// Effective deps: external prop takes priority, otherwise use internal
	const effectiveDeps = recording ?? internalDeps
	// Base URL: explicit prop wins, else the VITE_OPENHUMAN_BASE_URL env var,
	// else undefined (routes through the relative /api/openhuman proxy prefix).
	const baseURL = propBaseURL || import.meta.env.VITE_OPENHUMAN_BASE_URL || undefined
	const effectiveApiKey = propApiKey || import.meta.env.VITE_OPENHUMAN_CORE_TOKEN
	// Optional model override forwarded to channel_web_chat. Empty → server default.
	const effectiveModel = propModel || import.meta.env.VITE_OPENHUMAN_MODEL || undefined

	const isLoading = messages.some((m) => m.pending)

	useEffect(() => {
		const t = setTimeout(() => setVisible(true), 50)
		return () => clearTimeout(t)
	}, [])

	useEffect(() => {
		// When no explicit baseURL, route through the Vite proxy prefix so /health
		// hits the OpenHuman server rather than the dev server itself.
		const headers: Record<string, string> = {}
		if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

		const check = async () => {
			try {
				const r = await fetch(buildEndpoint(baseURL, '/health'), { headers })
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				// OpenHuman /health returns { healthy, degraded, uptime_seconds, ... }.
				const d = (await r.json()) as DetailedHealth
				const nextStatus: ServerHealth = d.healthy === false ? 'error' : 'ok'
				setHealth((prev) =>
					prev.status === nextStatus &&
					prev.detail?.degraded === d.degraded &&
					prev.detail?.uptime_seconds === d.uptime_seconds
						? prev
						: { status: nextStatus, detail: d }
				)
			} catch {
				setHealth((prev) => (prev.status === 'error' ? prev : { status: 'error', detail: null }))
			}
		}

		void check()
		const timer = setInterval(() => void check(), 30_000)
		return () => clearInterval(timer)
	}, [baseURL, effectiveApiKey])

	useEffect(() => {
		const el = historyRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [messages])

	// Abort in-flight request when panel unmounts
	useEffect(() => {
		return () => {
			abortRef.current?.abort()
		}
	}, [])

	// Create internal PageController + Recorder + Replayer when no external dep is provided
	useEffect(() => {
		if (recording) return
		const pc = new PageController()
		const rec = new Recorder(pc)
		const rep = new Replayer(pc)
		setInternalDeps({ recorder: rec, replayer: rep })
		return () => {
			rec.stop()
		}
	}, [recording])

	// Mount RecordingTab (vanilla JS) into the recListWrapper div
	useEffect(() => {
		if (!effectiveDeps || !recListRef.current) return
		const deps: RecordingTabDeps = {
			recorder: effectiveDeps.recorder,
			replayer: effectiveDeps.replayer,
		}
		const tab = new RecordingTab(deps)
		recListRef.current.appendChild(tab.element)
		recordingTabRef.current = tab
		return () => {
			tab.destroy()
			tab.element.remove()
			recordingTabRef.current = null
		}
		// effectiveDeps identity is stable: recording prop is external reference,
		// internalDeps is set once in the effect above
	}, [effectiveDeps])

	// Begin a recording session. Shared by the recording button and the
	// "开始录制" demo command. No-op if a session is already active.
	const startRecording = useCallback(() => {
		if (!effectiveDeps || isRecording) return
		const { recorder } = effectiveDeps
		sessionStartIndexRef.current = recorder.steps.length
		recorder.start()
		recordingTabRef.current?.setRecordingState(true)
		setIsRecording(true)
	}, [isRecording, effectiveDeps])

	// End the current recording session and persist it. Shared by the recording
	// button and the "结束录制" demo command. Returns the number of steps saved
	// (0 means nothing was recorded / no active session).
	const stopRecording = useCallback(async (): Promise<number> => {
		if (!effectiveDeps || !isRecording) return 0
		const { recorder } = effectiveDeps
		// Blur the active element so its change event fires before flush() is called.
		// Some browsers defer blur/change until after click, leaving inFlight empty.
		const active = document.activeElement
		if (active instanceof HTMLElement && active !== document.body) {
			active.blur()
		}
		await recorder.flush()
		recorder.stop()
		recorder.setAgentActing(false)
		const sessionSteps = recorder.steps.slice(sessionStartIndexRef.current)
		recordingTabRef.current?.setRecordingState(false)
		setIsRecording(false)
		if (sessionSteps.length > 0) {
			await saveRecording({
				name: `Recording ${new Date().toLocaleString()}`,
				steps: sessionSteps,
				startUrl: window.location.href,
			})
			await recordingTabRef.current?.renderHistory()
			// Auto-expand the list panel so user sees the saved recording
			setIsExpanded(false)
			setIsRecListExpanded(true)
		}
		return sessionSteps.length
	}, [isRecording, effectiveDeps])

	// Append a user command echo plus an assistant reply, mirroring the chat UI
	// so demo commands look like a normal exchange without hitting the server.
	const appendExchange = useCallback((command: string, reply: string) => {
		setMessages((prev) => [
			...prev,
			{ id: crypto.randomUUID(), role: 'user', content: command },
			{ id: crypto.randomUUID(), role: 'assistant', content: reply },
		])
		setIsExpanded(true)
	}, [])

	// Demo commands intercepted before the LLM/server. Recognized commands run
	// the recorder/replayer directly and return true; anything else returns false
	// so submit() falls through to the normal chat request (LLM).
	const handleDemoCommand = useCallback(
		async (text: string): Promise<boolean> => {
			if (!isDemoMode || !effectiveDeps) return false

			if (text === '开始录制') {
				startRecording()
				appendExchange(text, isRecording ? '已经在录制中了。' : '✅ 已开始录制，请在页面上操作。')
				return true
			}

			if (text === '结束录制') {
				if (!isRecording) {
					appendExchange(text, '当前没有正在进行的录制。')
					return true
				}
				const count = await stopRecording()
				appendExchange(
					text,
					count > 0
						? `✅ 已结束录制，共保存 ${count} 步操作。`
						: '⚠️ 已结束录制，但没有捕获到任何操作。'
				)
				return true
			}

			if (text === '回放结束') {
				effectiveDeps.replayer.abort()
				appendExchange(text, '⏹️ 已停止回放。')
				return true
			}

			// "回放" replays the latest recording; "回放 <name>" / "回放<name>"
			// replays the newest recording whose name matches (exact match
			// preferred, else substring). A separating space is optional since
			// Chinese input rarely includes one.
			if (text.startsWith('回放') && !text.startsWith('回放结束')) {
				const query = text.slice('回放'.length).trim()
				const recordings = await listRecordings() // newest first
				const target = query
					? (recordings.find((r) => r.name === query) ??
						recordings.find((r) => r.name.includes(query)))
					: recordings[0]
				if (!target) {
					appendExchange(
						text,
						query ? `⚠️ 没有找到名为「${query}」的录制。` : '⚠️ 没有可回放的录制。'
					)
					return true
				}
				// getRecording ensures we replay the freshest persisted steps.
				const full = await getRecording(target.id)
				const steps = full?.steps ?? target.steps
				if (steps.length === 0) {
					appendExchange(text, `⚠️ 录制「${target.name}」没有可回放的步骤。`)
					return true
				}
				appendExchange(text, `▶️ 开始回放「${target.name}」，共 ${steps.length} 步…`)
				await effectiveDeps.replayer.replay(steps)
				return true
			}

			return false
		},
		[isDemoMode, effectiveDeps, isRecording, startRecording, stopRecording, appendExchange]
	)

	// Send a message to the OpenHuman server (the normal LLM path). Echoes the
	// user message, opens the SSE stream, and posts the chat request.
	const sendToServer = useCallback(
		(text: string) => {
			const assistantId = crypto.randomUUID()

			setMessages((prev) => [
				...prev,
				{ id: crypto.randomUUID(), role: 'user', content: text },
				{ id: assistantId, role: 'assistant', content: '', pending: true },
			])
			setIsExpanded(true)

			const controller = new AbortController()
			abortRef.current = controller

			// Method B: mint a one-time SSE bind token, open the /events stream,
			// then POST the message. The SSE connection must be established before
			// sending so no early events are missed; events are correlated back to
			// this request by request_id. Multi-turn context lives server-side under
			// thread_id, so only the latest message is sent.
			const sendRequest = async () => {
				try {
					const clientId = (clientIdRef.current ??= `ext-${crypto.randomUUID().slice(0, 8)}`)
					const threadId = (threadIdRef.current ??= `t-${crypto.randomUUID().slice(0, 8)}`)

					const { token } = await rpc(
						baseURL,
						effectiveApiKey,
						'core.events_subscribe_token',
						{ client_id: clientId },
						controller.signal,
						1
					)

					const sse = await fetch(
						buildEndpoint(baseURL, '/events') +
							`?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`,
						{ signal: controller.signal }
					)
					if (!sse.ok || !sse.body) {
						throw new Error(`SSE HTTP ${sse.status}: ${await sse.text()}`)
					}

					const params: Record<string, unknown> = {
						client_id: clientId,
						thread_id: threadId,
						message: text,
					}
					if (effectiveModel) params.model_override = effectiveModel

					const ack = await rpc(
						baseURL,
						effectiveApiKey,
						'openhuman.channel_web_chat',
						params,
						controller.signal,
						2
					)
					// ack shape: { logs, result: { accepted, request_id, ... } }
					const myRequestId: string = ack?.result?.request_id ?? ''

					await readMethodBStream(sse, myRequestId, assistantId, setMessages)
				} catch (err) {
					const isAbort = err instanceof Error && err.name === 'AbortError'
					const errorMsg = err instanceof Error ? err.message : String(err)
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantId
								? { ...m, content: isAbort ? m.content : errorMsg, pending: false, error: !isAbort }
								: m
						)
					)
				} finally {
					abortRef.current = null
				}
			}

			void sendRequest()
		},
		[baseURL, effectiveApiKey, effectiveModel]
	)

	const submit = useCallback(
		(e: React.SyntheticEvent) => {
			e.preventDefault()
			effectiveDeps?.recorder.setAgentActing(false)
			const text = input.trim()
			if (!text || isLoading) return
			setInput('')

			// Demo mode: intercept recognized commands before the LLM/server.
			// Unrecognized input falls through to the normal chat request.
			if (isDemoMode) {
				void (async () => {
					const handled = await handleDemoCommand(text)
					if (!handled) sendToServer(text)
				})()
				return
			}

			sendToServer(text)
		},
		[input, isLoading, effectiveDeps, isDemoMode, handleDemoCommand, sendToServer]
	)

	const stop = useCallback(() => abortRef.current?.abort(), [])

	// A new conversation starts a fresh server-side thread and clears local state.
	// The client_id can be reused; only thread_id needs to change to drop context.
	const newConversation = useCallback(() => {
		abortRef.current?.abort()
		threadIdRef.current = `t-${crypto.randomUUID().slice(0, 8)}`
		setMessages([])
		setInput('')
		setIsExpanded(false)
	}, [])

	const toggleRecording = useCallback(async () => {
		if (!isRecording) startRecording()
		else await stopRecording()
	}, [isRecording, startRecording, stopRecording])

	const toggleRecList = useCallback(() => {
		setIsRecListExpanded((v) => {
			if (!v) {
				setIsExpanded(false)
				void recordingTabRef.current?.refresh()
			}
			return !v
		})
	}, [])

	const handleButtonPointerDown = useCallback(() => {
		if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
	}, [isRecording, effectiveDeps])

	return (
		<div
			data-openhuman-panel=""
			// Exclude the panel from DOM extraction, highlighting, and recording —
			// interactions with the panel chrome must never be indexed or recorded.
			data-page-agent-ignore="true"
			className={[
				styles.wrapper,
				isExpanded ? styles.expanded : '',
				isRecListExpanded ? styles.recListShown : '',
			].join(' ')}
			style={{
				opacity: visible ? 1 : 0,
				transform: visible ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(20px)',
			}}
		>
			<div className={styles.background} />

			<div className={styles.historySectionWrapper}>
				<div className={styles.historySection} ref={historyRef}>
					{messages.length === 0 ? (
						<div className={styles.historyItem}>
							<div className={styles.historyContent}>
								<span className={styles.statusIcon}>🧠</span>
								<span>向 OpenHuman 发送指令，开始浏览器自动化任务</span>
							</div>
						</div>
					) : (
						messages.map((msg) => (
							<div key={msg.id} className={`${styles.historyItem} ${messageItemClass(msg)}`}>
								<div className={styles.historyContent}>
									<span className={styles.statusIcon}>{msg.role === 'user' ? '👤' : '🤖'}</span>
									<span>{msg.content || (msg.pending ? '…' : '')}</span>
								</div>
							</div>
						))
					)}
				</div>
			</div>

			<div className={styles.header} onClick={() => setIsExpanded((v) => !v)}>
				<div
					className={styles.statusSection}
					title={buildHealthTooltip(health.status, health.detail)}
				>
					<div
						className={[
							styles.indicator,
							isLoading
								? styles.thinking
								: health.status === 'error'
									? styles.error
									: styles.completed,
						].join(' ')}
					/>
					<div className={styles.statusText}>{isLoading ? '正在思考...' : 'OpenHuman Agent'}</div>
				</div>
				<div className={styles.controls}>
					{effectiveDeps && (
						<button
							className={[styles.controlButton, isDemoMode ? styles.recListBtnActive : ''].join(
								' '
							)}
							title={isDemoMode ? '演示模式：开（命令不走 LLM）' : '演示模式：关'}
							onPointerDown={handleButtonPointerDown}
							onClick={(e) => {
								e.stopPropagation()
								setIsDemoMode((v) => !v)
								effectiveDeps?.recorder.setAgentActing(false)
							}}
						>
							🎬
						</button>
					)}
					{effectiveDeps && (
						<button
							className={[
								styles.controlButton,
								styles.recordingButton,
								isRecording ? styles.recordingActive : '',
							].join(' ')}
							title={isRecording ? '停止录制' : '开始录制'}
							onPointerDown={handleButtonPointerDown}
							onClick={(e) => {
								e.stopPropagation()
								void toggleRecording()
							}}
						>
							{isRecording ? '■' : '●'}
						</button>
					)}
					{effectiveDeps && (
						<button
							className={[
								styles.controlButton,
								styles.recListButton,
								isRecListExpanded ? styles.recListBtnActive : '',
							].join(' ')}
							title="录制列表"
							onPointerDown={handleButtonPointerDown}
							onClick={(e) => {
								e.stopPropagation()
								toggleRecList()
								effectiveDeps?.recorder.setAgentActing(false)
							}}
						>
							≡
						</button>
					)}
					<button
						className={styles.controlButton}
						title="新对话"
						onPointerDown={handleButtonPointerDown}
						onClick={(e) => {
							e.stopPropagation()
							newConversation()
							effectiveDeps?.recorder.setAgentActing(false)
						}}
					>
						+
					</button>
					<button
						className={`${styles.controlButton} ${styles.expandButton}`}
						title={isExpanded ? '收起' : '展开历史'}
						onPointerDown={handleButtonPointerDown}
						onClick={(e) => {
							e.stopPropagation()
							setIsExpanded((v) => {
								if (!v) setIsRecListExpanded(false)
								return !v
							})
							effectiveDeps?.recorder.setAgentActing(false)
						}}
					>
						{isExpanded ? '▲' : '▼'}
					</button>
					<button
						className={`${styles.controlButton} ${styles.stopButton}`}
						title={isLoading ? '停止' : '关闭'}
						onPointerDown={handleButtonPointerDown}
						onClick={(e) => {
							e.stopPropagation()
							if (isLoading) stop()
							else {
								setVisible(false)
								onClose?.()
							}
							effectiveDeps?.recorder.setAgentActing(false)
						}}
					>
						{isLoading ? '■' : 'X'}
					</button>
				</div>
			</div>

			<div className={styles.recListWrapper} ref={recListRef} />

			<div className={styles.inputSectionWrapper}>
				<form className={styles.inputSection} onSubmit={submit}>
					<input
						className={styles.taskInput}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={
							isDemoMode
								? '演示模式：开始录制 / 结束录制 / 回放 [名称] / 回放结束'
								: '告诉 OpenHuman 做什么...'
						}
						maxLength={1000}
						disabled={isLoading}
					/>
					{isLoading ? (
						<button
							type="button"
							onPointerDown={handleButtonPointerDown}
							onClick={(e) => {
								e.stopPropagation()
								stop()
								effectiveDeps?.recorder.setAgentActing(false)
							}}
							style={STOP_BUTTON_STYLE}
						>
							停止
						</button>
					) : (
						<button
							type="submit"
							disabled={!input.trim()}
							onPointerDown={handleButtonPointerDown}
							style={BASE_BUTTON_STYLE}
						>
							发送
						</button>
					)}
				</form>
			</div>
		</div>
	)
}

function buildHealthTooltip(status: ServerHealth, detail: DetailedHealth | null): string {
	if (status === null) return ''
	if (status === 'error') return 'Server unreachable'
	const parts: string[] = [detail?.degraded ? 'Server: degraded' : 'Server: ok']
	if (detail?.uptime_seconds != null) {
		parts.push(`Uptime: ${Math.floor(detail.uptime_seconds)}s`)
	}
	return parts.join(' · ')
}
