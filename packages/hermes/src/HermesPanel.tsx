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

interface DetailedHealth {
	status?: string
	active_sessions?: number
	running_agents?: number
	[key: string]: unknown
}

interface HermesCapabilities {
	object: string
	platform: string
	model: string
	auth: { type: string; required: boolean }
	features: {
		chat_completions?: boolean
		responses_api?: boolean
		run_submission?: boolean
		run_status?: boolean
		run_events_sse?: boolean
		run_stop?: boolean
	}
}

interface RecordingDeps {
	recorder: Recorder
	replayer: Replayer
}

interface HermesPanelProps {
	/** Hermes server base URL, e.g. 'http://localhost:8642'. Falls back to vite proxy when omitted. */
	baseURL?: string
	/** Bearer token for the Hermes server. Falls back to VITE_HERMES_API_KEY env var when omitted. */
	apiKey?: string
	/** Called when the user closes the panel. */
	onClose?: () => void
	/**
	 * External recording deps. When omitted, HermesPanel creates its own
	 * PageController + Recorder + Replayer automatically.
	 */
	recording?: RecordingDeps
}

function messageItemClass(msg: Message): string {
	if (msg.role === 'user') return styles.input
	if (msg.error) return styles.error
	if (msg.pending) return styles.observation
	return styles.output
}

// localStorage may throw in sandboxed iframes — fall back to an in-memory UUID
function getSessionKey(): string {
	try {
		const stored = localStorage.getItem('hermes-session-key')
		if (stored) return stored
		const key = crypto.randomUUID()
		localStorage.setItem('hermes-session-key', key)
		return key
	} catch {
		return crypto.randomUUID()
	}
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

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue
				const payload = line.slice(6).trim()
				if (payload === '[DONE]') continue
				try {
					const chunk = JSON.parse(payload) as {
						choices?: { delta?: { content?: string } }[]
					}
					const delta = chunk.choices?.[0]?.delta?.content ?? ''
					if (!delta) continue
					hasContent = true
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantId ? { ...m, content: m.content + delta, pending: false } : m
						)
					)
				} catch {
					// ignore malformed SSE chunks
				}
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

export function HermesPanel({
	baseURL,
	apiKey: propApiKey,
	onClose,
	recording,
}: HermesPanelProps = {}) {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [isExpanded, setIsExpanded] = useState(false)
	const [visible, setVisible] = useState(false)
	const [isRecording, setIsRecording] = useState(false)
	const [isRecListExpanded, setIsRecListExpanded] = useState(false)
	const [capabilities, setCapabilities] = useState<HermesCapabilities | null>(null)
	const [serverHealth, setServerHealth] = useState<ServerHealth>(null)
	const [detailedHealth, setDetailedHealth] = useState<DetailedHealth | null>(null)
	// Internal deps created when recording prop is not provided
	const [internalDeps, setInternalDeps] = useState<RecordingDeps | null>(null)

	const abortRef = useRef<AbortController | null>(null)
	const historyRef = useRef<HTMLDivElement>(null)
	const recListRef = useRef<HTMLDivElement>(null)
	const recordingTabRef = useRef<RecordingTab | null>(null)
	const sessionStartIndexRef = useRef(0)
	// useState lazy initializer runs getSessionKey exactly once
	const [sessionKey] = useState(getSessionKey)

	// Effective deps: external prop takes priority, otherwise use internal
	const effectiveDeps = recording ?? internalDeps

	const isLoading = messages.some((m) => m.pending)

	useEffect(() => {
		const t = setTimeout(() => setVisible(true), 50)
		return () => clearTimeout(t)
	}, [])

	useEffect(() => {
		// When no explicit baseURL, route through the Vite proxy prefix so /health
		// hits the Hermes server rather than the dev server itself.
		const healthBase = baseURL ?? '/api/hermes'
		const effectiveApiKey = propApiKey || import.meta.env.VITE_HERMES_API_KEY
		const headers: Record<string, string> = {}
		if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

		const check = async () => {
			try {
				const r = await fetch(`${healthBase}/health`, { headers })
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				setServerHealth('ok')
				fetch(`${healthBase}/health/detailed`, { headers })
					.then((dr) => (dr.ok ? dr.json() : null))
					.then((d: DetailedHealth | null) => setDetailedHealth(d))
					.catch(() => {})
			} catch {
				setServerHealth('error')
				setDetailedHealth(null)
			}
		}

		void check()
		const timer = setInterval(() => void check(), 30_000)
		return () => clearInterval(timer)
	}, [baseURL, propApiKey])

	useEffect(() => {
		const endpoint = baseURL ? `${baseURL}/v1/capabilities` : '/api/hermes/v1/capabilities'
		const effectiveApiKey = propApiKey || import.meta.env.VITE_HERMES_API_KEY
		const headers: Record<string, string> = {}
		if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

		fetch(endpoint, { headers })
			.then((r) => (r.ok ? r.json() : null))
			.then((data: HermesCapabilities | null) => {
				if (data?.object === 'hermes.api_server.capabilities') setCapabilities(data)
			})
			.catch(() => {
				// capabilities endpoint unavailable — degrade gracefully
			})
	}, [baseURL, propApiKey])

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
						'X-Hermes-Session-Key': sessionKey,
					}
					const effectiveApiKey = propApiKey || import.meta.env.VITE_HERMES_API_KEY
					if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`

					const endpoint = baseURL
						? `${baseURL}/v1/chat/completions`
						: '/api/hermes/v1/chat/completions'
					const resp = await fetch(endpoint, {
						method: 'POST',
						headers,
						body: JSON.stringify({
							model: capabilities?.model ?? 'hermes-agent',
							messages: apiMessages,
							stream: capabilities?.features.run_events_sse ?? true,
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
		[input, isLoading, messages, sessionKey, baseURL, propApiKey, effectiveDeps, capabilities]
	)

	const stop = useCallback(() => abortRef.current?.abort(), [])

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

	return (
		<div
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
					{capabilities?.auth.required && !(propApiKey || import.meta.env.VITE_HERMES_API_KEY) && (
						<div className={`${styles.historyItem} ${styles.error}`}>
							<div className={styles.historyContent}>
								<span className={styles.statusIcon}>⚠️</span>
								<span>
									Server requires authentication. Provide apiKey prop or set VITE_HERMES_API_KEY.
								</span>
							</div>
						</div>
					)}
					{messages.length === 0 ? (
						<div className={styles.historyItem}>
							<div className={styles.historyContent}>
								<span className={styles.statusIcon}>🧠</span>
								<span>向 Hermes 发送指令，开始浏览器自动化任务</span>
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
					title={buildHealthTooltip(serverHealth, detailedHealth)}
				>
					<div
						className={[
							styles.indicator,
							isLoading
								? styles.thinking
								: serverHealth === 'error'
									? styles.error
									: styles.completed,
						].join(' ')}
					/>
					<div className={styles.statusText}>{isLoading ? '正在思考...' : 'Hermes Agent'}</div>
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
							onPointerDown={() => {
								if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
							}}
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
							onPointerDown={() => {
								if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
							}}
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
						className={`${styles.controlButton} ${styles.expandButton}`}
						title={isExpanded ? '收起' : '展开历史'}
						onPointerDown={() => {
							if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
						}}
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
						onPointerDown={() => {
							if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
						}}
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
						placeholder="告诉 Hermes 做什么..."
						maxLength={1000}
						disabled={isLoading}
					/>
					{isLoading ? (
						<button
							type="button"
							onPointerDown={() => {
								if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
							}}
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
							onPointerDown={() => {
								if (isRecording && effectiveDeps) effectiveDeps.recorder.setAgentActing(true)
							}}
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

function buildHealthTooltip(health: ServerHealth, detail: DetailedHealth | null): string {
	if (health === null) return ''
	if (health === 'error') return 'Server unreachable'
	const parts: string[] = ['Server: ok']
	if (detail?.active_sessions != null) parts.push(`Sessions: ${detail.active_sessions}`)
	if (detail?.running_agents != null) parts.push(`Agents: ${detail.running_agents}`)
	return parts.join(' · ')
}
