/**
 * useSoldierSocket
 *
 * Connects the browser directly to the soldier MCP server's embedded
 * WebSocket hub — no OpenHuman backend in between. The MCP server's
 * `play_animation` tool pushes a `soldier_command` frame down this socket;
 * we drive `window.playAnimation(name)` (exposed by SoldierViewer) and send
 * a `soldier_result` frame back so the tool call can resolve.
 *
 * Adapted from col_sys_chain/frontend/src/hooks/useWebSocket.ts, stripped of
 * that app's mission-store logic — this package only cares about the soldier
 * animation channel.
 */
import { useCallback, useEffect, useRef } from 'react'

/** Reconnect tuning. */
const RECONNECT_DELAY = 3000 // reconnect interval (ms)
const MAX_RECONNECT_ATTEMPTS = 10

/**
 * Close codes the server sends deliberately; the client must NOT reconnect on
 * these. 4002 = "replaced by a new connection": a newer socket has already taken
 * over this userId, so the old one reconnecting just steals it back, and the two
 * ping-pong every RECONNECT_DELAY. Each takeover also rejects any in-flight
 * play_animation with "Replaced by a new avatar connection" — which is exactly
 * the spurious error the animation call was hitting despite playing fine.
 * 4001 = bad URL (missing userId): reconnecting can never fix a malformed URL.
 */
const NON_RETRYABLE_CLOSE_CODES = new Set([1000, 4001, 4002])

/** Frame pushed by the MCP server's play_animation tool. */
interface SoldierCommandFrame {
	type: 'soldier_command'
	payload?: { action?: string; animation?: string }
}

interface UseSoldierSocketOptions {
	/**
	 * Full WebSocket URL of the soldier MCP server's embedded hub, e.g.
	 * `ws://localhost:38402/ws/<userId>`. When omitted, falls back to
	 * VITE_OPENHUMAN_SOLDIER_WS, then to `ws://localhost:38402/ws/<userId>`.
	 */
	url?: string
	/** Connection identifier the MCP server addresses commands to. */
	userId?: string
	/** Enable the connection. Defaults to true. */
	enabled?: boolean
}

/** Resolve the soldier WS URL from explicit prop → env → localhost default. */
function resolveSoldierWsUrl(url: string | undefined, userId: string | undefined): string | null {
	if (url) return url
	const base = import.meta.env.VITE_OPENHUMAN_SOLDIER_WS
	const id = userId ?? 'default'
	if (base) {
		// Allow either a full URL or a base to which we append /ws/<userId>.
		return base.includes('/ws/') ? base : `${base.replace(/\/$/, '')}/ws/${id}`
	}
	return `ws://localhost:38402/ws/${id}`
}

/**
 * Open a direct WebSocket to the soldier MCP server and bridge its
 * animation commands to the on-page 3D avatar.
 *
 * @returns a ref to the live WebSocket (null while disconnected).
 */
export function useSoldierSocket({ url, userId, enabled = true }: UseSoldierSocketOptions = {}) {
	const wsRef = useRef<WebSocket | null>(null)
	const reconnectCountRef = useRef(0)
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	/** Handle a frame from the soldier MCP server. */
	const handleMessage = useCallback((event: MessageEvent) => {
		let data: unknown
		try {
			data = JSON.parse(event.data)
		} catch {
			console.warn('[soldier-ws] failed to parse frame:', event.data)
			return
		}

		const frame = data as { type?: string }
		switch (frame.type) {
			case 'soldier_command': {
				// Animation command from the MCP server's play_animation tool.
				const animation = (frame as SoldierCommandFrame).payload?.animation || 'IDLE'
				console.debug('[soldier-ws] soldier_command animation=%s', animation)
				let result = '❌ playAnimation not ready'
				if (window.playAnimation) {
					result = window.playAnimation(animation)
				}
				// Reply on the SAME socket the command arrived on (event.currentTarget),
				// never wsRef.current. After a reconnect/handoff, wsRef.current can point
				// at a newer or already-closed socket, so the result frame would be sent
				// on the wrong (or non-OPEN) socket and silently dropped — leaving the
				// server's play_animation to hang until its 15s timeout even though the
				// animation played fine.
				const ws = event.currentTarget as WebSocket
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'soldier_result', payload: { result } }))
				}
				break
			}
			default:
				console.debug('[soldier-ws] unhandled frame type:', frame.type)
		}
	}, [])

	/** Establish the WebSocket connection to the soldier MCP server. */
	const connect = useCallback(() => {
		if (!enabled) return
		const wsUrl = resolveSoldierWsUrl(url, userId)
		if (!wsUrl) return

		console.debug('[soldier-ws] connecting to %s', wsUrl)
		const ws = new WebSocket(wsUrl)

		ws.onopen = () => {
			console.log('[soldier-ws] connected')
			reconnectCountRef.current = 0
		}

		ws.onmessage = handleMessage

		ws.onclose = (event) => {
			console.log('[soldier-ws] closed:', event.code)
			wsRef.current = null
			// Reconnect only on abnormal close, and never on a code the server
			// closed with deliberately (see NON_RETRYABLE_CLOSE_CODES) — retrying
			// those causes a reconnect storm, not recovery.
			if (
				!NON_RETRYABLE_CLOSE_CODES.has(event.code) &&
				reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS
			) {
				reconnectCountRef.current += 1
				console.log(
					`[soldier-ws] reconnecting in ${RECONNECT_DELAY / 1000}s (attempt ${reconnectCountRef.current})...`
				)
				reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY)
			}
		}

		ws.onerror = (error) => {
			console.error('[soldier-ws] error:', error)
		}

		wsRef.current = ws
	}, [enabled, url, userId, handleMessage])

	// Connect on mount, tear down on unmount.
	useEffect(() => {
		connect()

		return () => {
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
			}
			if (wsRef.current) {
				wsRef.current.close(1000, 'component unmounted')
				wsRef.current = null
			}
		}
	}, [connect])

	return wsRef
}
