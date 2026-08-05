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

/** Frame pushed by the MCP server's play_animation tool. */
interface SoldierCommandFrame {
	type: 'soldier_command'
	payload?: { action?: string; animation?: string }
}

interface UseSoldierSocketOptions {
	/**
	 * Full WebSocket URL of the soldier MCP server's embedded hub, e.g.
	 * `ws://localhost:8765/ws/<userId>`. When omitted, falls back to
	 * VITE_OPENHUMAN_SOLDIER_WS, then to `ws://localhost:8765/ws/<userId>`.
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
	return `ws://localhost:8765/ws/${id}`
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
				// Report execution result back so the tool call can resolve.
				const ws = wsRef.current
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
			// Reconnect on abnormal close, up to the attempt cap.
			if (event.code !== 1000 && reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS) {
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
