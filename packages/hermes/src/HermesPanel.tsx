import React, { useCallback, useEffect, useRef, useState } from 'react'

import styles from '../../ui/src/panel/Panel.module.css'

interface Message {
	id: string
	role: 'user' | 'assistant'
	content: string
	pending?: boolean
	error?: boolean
}

interface HermesPanelProps {
	/** Hermes server base URL, e.g. 'http://localhost:8642'. Falls back to vite proxy when omitted. */
	baseURL?: string
	/** Bearer token for the Hermes server. Falls back to VITE_HERMES_API_KEY env var when omitted. */
	apiKey?: string
	/** Called when the user closes the panel. */
	onClose?: () => void
}

function messageItemClass(msg: Message): string {
	if (msg.role === 'user') return styles.input
	if (msg.error) return styles.error
	if (msg.pending) return styles.observation
	return styles.output
}

// Stable per-browser session key scoping Hermes long-term memory (X-Hermes-Session-Key)
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

const SEND_BUTTON_STYLE: React.CSSProperties = {
	...BASE_BUTTON_STYLE,
}

const STOP_BUTTON_STYLE: React.CSSProperties = {
	...BASE_BUTTON_STYLE,
	background: 'rgba(239,68,68,0.25)',
	color: 'rgb(255,100,100)',
}

export function HermesPanel({ baseURL, apiKey: propApiKey, onClose }: HermesPanelProps = {}) {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [isExpanded, setIsExpanded] = useState(false)
	const [visible, setVisible] = useState(false)
	const abortRef = useRef<AbortController | null>(null)
	const historyRef = useRef<HTMLDivElement>(null)
	const sessionKey = useRef(getSessionKey()).current

	const isLoading = messages.some((m) => m.pending)

	useEffect(() => {
		const t = setTimeout(() => setVisible(true), 50)
		return () => clearTimeout(t)
	}, [])

	useEffect(() => {
		const el = historyRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [messages])

	const submit = useCallback(
		(e: React.SyntheticEvent) => {
			e.preventDefault()
			const text = input.trim()
			if (!text || isLoading) return

			// Build API payload before state update to avoid stale closure
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
						body: JSON.stringify({ model: 'hermes-agent', messages: apiMessages, stream: true }),
						signal: controller.signal,
					})

					if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)

					if (resp.headers.get('content-type')?.includes('text/event-stream')) {
						await readSSEStream(resp, assistantId)
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
		[input, isLoading, messages, sessionKey]
	)

	const readSSEStream = async (resp: Response, assistantId: string) => {
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

	const stop = useCallback(() => abortRef.current?.abort(), [])

	return (
		<div
			className={`${styles.wrapper} ${isExpanded ? styles.expanded : ''}`}
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
				<div className={styles.statusSection}>
					<div
						className={`${styles.indicator} ${isLoading ? styles.thinking : styles.completed}`}
					/>
					<div className={styles.statusText}>{isLoading ? '正在思考...' : 'Hermes Agent'}</div>
				</div>
				<div className={styles.controls}>
					<button
						className={`${styles.controlButton} ${styles.expandButton}`}
						title={isExpanded ? '收起' : '展开历史'}
						onClick={(e) => {
							e.stopPropagation()
							setIsExpanded((v) => !v)
						}}
					>
						{isExpanded ? '▲' : '▼'}
					</button>
					<button
						className={`${styles.controlButton} ${styles.stopButton}`}
						title={isLoading ? '停止' : '关闭'}
						onClick={(e) => {
							e.stopPropagation()
							if (isLoading) stop()
							else {
								setVisible(false)
								onClose?.()
							}
						}}
					>
						{isLoading ? '■' : 'X'}
					</button>
				</div>
			</div>

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
							onClick={(e) => {
								e.stopPropagation()
								stop()
							}}
							style={STOP_BUTTON_STYLE}
						>
							停止
						</button>
					) : (
						<button type="submit" disabled={!input.trim()} style={SEND_BUTTON_STYLE}>
							发送
						</button>
					)}
				</form>
			</div>
		</div>
	)
}
