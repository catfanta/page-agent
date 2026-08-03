import { PageController } from '@page-agent/page-controller'
import { Recorder, Replayer, saveRecording } from '@page-agent/recorder'
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

// OpenHuman /health response (openhuman-web, method C).
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

// One entry from GET /v1/models (OpenAI-compatible model list).
interface ModelInfo {
	id: string
	object?: string
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
	/** Model id for chat completions. Falls back to the first model from /v1/models, then 'chat-v1'. */
	model?: string
	/** Called when the user closes the panel. */
	onClose?: () => void
	/**
	 * External recording deps. When omitted, OpenHumanPanel creates its own
	 * PageController + Recorder + Replayer automatically.
	 */
	recording?: RecordingDeps
}

function buildEndpoint(baseURL: string | undefined, path: string): string {
	return baseURL ? `${baseURL}${path}` : `/api/openhuman${path}`
}

function messageItemClass(msg: Message): string {
	if (msg.role === 'user') return styles.input
	if (msg.error) return styles.error
	if (msg.pending) return styles.observation
	return styles.output
}

async function readSSEStream(
	resp: Response,
	assistantId: string,
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>
) {
	const reader = resp.body!.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let hasContent = false

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''

			// Accumulate all deltas from this read() chunk before updating state
			let accumulated = ''
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue
				const payload = line.slice(6).trim()
				if (payload === '[DONE]') continue
				try {
					const chunk = JSON.parse(payload) as {
						choices?: { delta?: { content?: string } }[]
					}
					accumulated += chunk.choices?.[0]?.delta?.content ?? ''
				} catch {
					// ignore malformed SSE chunks
				}
			}
			if (accumulated) {
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
}) => {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [isExpanded, setIsExpanded] = useState(false)
	const [visible, setVisible] = useState(false)
	const [isRecording, setIsRecording] = useState(false)
	const [isRecListExpanded, setIsRecListExpanded] = useState(false)
	const [models, setModels] = useState<ModelInfo[]>([])
	const [health, setHealth] = useState<HealthState>({ status: null, detail: null })
	// Internal deps created when recording prop is not provided
	const [internalDeps, setInternalDeps] = useState<RecordingDeps | null>(null)

	const abortRef = useRef<AbortController | null>(null)
	const historyRef = useRef<HTMLDivElement>(null)
	const recListRef = useRef<HTMLDivElement>(null)
	const recordingTabRef = useRef<RecordingTab | null>(null)
	const sessionStartIndexRef = useRef(0)

	// Effective deps: external prop takes priority, otherwise use internal
	const effectiveDeps = recording ?? internalDeps
	// Base URL: explicit prop wins, else the VITE_OPENHUMAN_BASE_URL env var,
	// else undefined (routes through the relative /api/openhuman proxy prefix).
	const baseURL = propBaseURL || import.meta.env.VITE_OPENHUMAN_BASE_URL || undefined
	const effectiveApiKey = propApiKey || import.meta.env.VITE_OPENHUMAN_CORE_TOKEN
	// Model id: explicit prop wins, else the VITE_OPENHUMAN_MODEL env var,
	// else the first advertised model, else the doc default.
	const effectiveModel =
		propModel ?? import.meta.env.VITE_OPENHUMAN_MODEL ?? models[0]?.id ?? 'chat-v1'

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
		// GET /v1/models to pick a default model id. Some deployments gate it behind
		// the same Bearer token as /rpc, so send the token when we have one.
		const headers: Record<string, string> = {}
		if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

		fetch(buildEndpoint(baseURL, '/v1/models'), { headers })
			.then((r) => (r.ok ? r.json() : null))
			.then((data: { data?: ModelInfo[] } | null) => {
				if (Array.isArray(data?.data)) setModels(data.data)
			})
			.catch(() => {
				// models endpoint unavailable — fall back to the default model id
			})
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

	const submit = useCallback(
		(e: React.SyntheticEvent) => {
			e.preventDefault()
			effectiveDeps?.recorder.setAgentActing(false)
			const text = input.trim()
			if (!text || isLoading) return

			const apiMessages = [
				...messages.map((m) => ({ role: m.role, content: m.content })),
				{ role: 'user' as const, content: text },
			]
			const assistantId = crypto.randomUUID()

			setMessages((prev) => [
				...prev,
				{ id: crypto.randomUUID(), role: 'user', content: text },
				{ id: assistantId, role: 'assistant', content: '', pending: true },
			])
			setInput('')
			setIsExpanded(true)

			const controller = new AbortController()
			abortRef.current = controller

			const sendRequest = async () => {
				try {
					const headers: Record<string, string> = {
						'Content-Type': 'application/json',
					}
					if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

					const resp = await fetch(buildEndpoint(baseURL, '/v1/chat/completions'), {
						method: 'POST',
						headers,
						body: JSON.stringify({
							model: effectiveModel,
							messages: apiMessages,
							stream: true,
						}),
						signal: controller.signal,
					})

					if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)

					if (resp.headers.get('content-type')?.includes('text/event-stream')) {
						await readSSEStream(resp, assistantId, setMessages)
					} else {
						const data = (await resp.json()) as {
							choices?: { message?: { content?: string } }[]
						}
						const content = data.choices?.[0]?.message?.content ?? ''
						setMessages((prev) =>
							prev.map((m) => (m.id === assistantId ? { ...m, content, pending: false } : m))
						)
					}
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
		[input, isLoading, messages, baseURL, effectiveApiKey, effectiveDeps, effectiveModel]
	)

	const stop = useCallback(() => abortRef.current?.abort(), [])

	// Method C is stateless: multi-turn context lives entirely in the `messages`
	// array, so a new conversation just clears local state.
	const newConversation = useCallback(() => {
		abortRef.current?.abort()
		setMessages([])
		setInput('')
		setIsExpanded(false)
	}, [])

	const toggleRecording = useCallback(async () => {
		if (!effectiveDeps) return
		const { recorder } = effectiveDeps
		if (!isRecording) {
			sessionStartIndexRef.current = recorder.steps.length
			recorder.start()
			recordingTabRef.current?.setRecordingState(true)
			setIsRecording(true)
		} else {
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
		}
	}, [isRecording, effectiveDeps])

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
						placeholder="告诉 OpenHuman 做什么..."
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
