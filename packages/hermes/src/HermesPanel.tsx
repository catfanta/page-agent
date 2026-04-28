import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import styles from '../../ui/src/panel/Panel.module.css'

const hermes = createOpenAICompatible({
	name: 'hermes-agent',
	baseURL: '/api/hermes/v1',
	apiKey: 'change-me-local-dev',
})

interface Message {
	id: string
	role: 'user' | 'assistant'
	content: string
	streaming?: boolean
	error?: boolean
}

function messageItemClass(msg: Message): string {
	if (msg.role === 'user') return styles.input
	if (msg.error) return styles.error
	if (msg.streaming) return styles.observation
	return styles.output
}

export function HermesPanel() {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [isExpanded, setIsExpanded] = useState(false)
	const [visible, setVisible] = useState(false)
	const abortRef = useRef<AbortController | null>(null)
	const historyRef = useRef<HTMLDivElement>(null)
	// ref shadow lets stream() read latest messages without stale-closure issues
	const messagesRef = useRef<Message[]>(messages)
	messagesRef.current = messages

	const isLoading = messages.some((m) => m.streaming)

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

			const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text }
			const assistantId = crypto.randomUUID()

			// flushSync forces a render before the async stream starts, preventing React 18
			// from batching this state update with a fast error's cleanup into a single frame
			// eslint-disable-next-line @eslint-react/dom-no-flush-sync
			flushSync(() => {
				setMessages((prev) => [
					...prev,
					userMsg,
					{ id: assistantId, role: 'assistant', content: '', streaming: true },
				])
				setInput('')
				setIsExpanded(true)
			})

			abortRef.current = new AbortController()

			const stream = async () => {
				try {
					const result = streamText({
						model: hermes('hermes-agent'),
						// flushSync already committed userMsg into messagesRef — filter out only the placeholder
						messages: messagesRef.current
							.filter((m) => !m.streaming)
							.map((m) => ({ role: m.role, content: m.content })),
						abortSignal: abortRef.current!.signal,
					})

					for await (const delta of result.textStream) {
						setMessages((prev) =>
							prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m))
						)
					}

					setMessages((prev) =>
						prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m))
					)
				} catch (err) {
					const isAbort = (err as Error).name === 'AbortError'
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantId
								? {
										...m,
										content: isAbort ? m.content : err instanceof Error ? err.message : String(err),
										streaming: false,
										error: !isAbort,
									}
								: m
						)
					)
				} finally {
					abortRef.current = null
				}
			}

			void stream()
		},
		[input, isLoading]
	)

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
									<span>{msg.content || (msg.streaming ? '…' : '')}</span>
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
							else setVisible(false)
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
							className={styles.controlButton}
							style={{
								width: 'auto',
								padding: '0 8px',
								background: 'rgba(239,68,68,0.25)',
								color: 'rgb(255,100,100)',
							}}
						>
							停止
						</button>
					) : (
						<button
							type="submit"
							disabled={!input.trim()}
							className={styles.controlButton}
							style={{ width: 'auto', padding: '0 8px' }}
						>
							发送
						</button>
					)}
				</form>
			</div>
		</div>
	)
}
