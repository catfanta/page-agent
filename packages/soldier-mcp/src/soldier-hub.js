#!/usr/bin/env node
import http from 'node:http'
import { WebSocketServer } from 'ws'

const LOOPBACK_HOST = 'localhost'

/** How long to wait for a `soldier_result` before failing a command (ms). */
const COMMAND_TIMEOUT_MS = 15000

/**
 * WebSocket bridge to OpenHuman's on-page avatar.
 *
 * Unlike page-agent's HubBridge (a single extension hub reverse-connects and is
 * addressed as one peer), the soldier avatar is per-browser: each OpenHuman page
 * opens `ws://host:port/ws/<userId>` via useSoldierSocket, so one server fans out
 * to many browsers keyed by userId. We therefore keep a `Map<userId, socket>`
 * instead of a single hub reference.
 *
 * Protocol (must match packages/openhuman/src/hooks/useWebSocket.ts):
 *   server → browser:  { type: 'soldier_command', payload: { animation } }
 *   browser → server:  { type: 'soldier_result', payload: { result } }
 *
 * The result frame carries no correlation id, so a connection may only have one
 * command in flight at a time. We serialize per-connection: a second command for
 * the same userId while one is pending is rejected rather than silently racing
 * the shared result slot. Commands to *different* userIds run concurrently.
 */
export class SoldierHub {
	/** @type {number} */
	port

	/** @type {http.Server} */
	#httpServer

	/** @type {WebSocketServer} */
	#wss

	/**
	 * Live avatar connections keyed by userId.
	 * @type {Map<string, import('ws').WebSocket>}
	 */
	#connections = new Map()

	/**
	 * The single in-flight command per userId. The result frame has no id, so at
	 * most one command may await a result on a given socket.
	 * @type {Map<string, { resolve: (result: string) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, animation: string }>}
	 */
	#pending = new Map()

	/** @param {number} port */
	constructor(port) {
		this.port = port
		// A bare HTTP server the WS server upgrades from. Plain GETs get a hint so
		// a human hitting the URL in a browser sees why nothing happens.
		this.#httpServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
			res.end('soldier-mcp WebSocket hub. Connect via ws://<host>/ws/<userId>.\n')
		})
		this.#wss = new WebSocketServer({ server: this.#httpServer })
		this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req))
	}

	/** @returns {Promise<void>} */
	async start() {
		return new Promise((resolve, reject) => {
			this.#httpServer.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
				if (err.code === 'EADDRINUSE') {
					reject(
						new Error(`Port ${this.port} is in use. Another soldier-mcp server may be running.`)
					)
				} else {
					reject(err)
				}
			})
			this.#httpServer.listen(this.port, LOOPBACK_HOST, () => {
				console.error(`[soldier-mcp] WS hub on ws://${LOOPBACK_HOST}:${this.port}/ws/<userId>`)
				resolve()
			})
		})
	}

	/** userIds with a live avatar connection. */
	get connections() {
		return [...this.#connections.keys()]
	}

	/** @param {string} userId */
	isConnected(userId) {
		return this.#connections.get(userId)?.readyState === 1
	}

	/**
	 * Push an animation command to a specific browser and await its result frame.
	 * @param {string} userId
	 * @param {string} animation
	 * @returns {Promise<string>} the `result` string reported by window.playAnimation
	 */
	async playAnimation(userId, animation) {
		const ws = this.#connections.get(userId)
		if (!ws || ws.readyState !== 1) {
			throw new Error(
				`No avatar connected for userId "${userId}". Connected: ${this.connections.join(', ') || '(none)'}`
			)
		}
		if (this.#pending.has(userId)) {
			throw new Error(`An animation command is already in flight for userId "${userId}".`)
		}

		return new Promise((resolve, reject) => {
			// The result frame is uncorrelated, so a hung or protocol-mismatched
			// client would leave this promise pending forever and freeze the MCP
			// tool call. A timeout turns that into a fast, actionable error.
			const timer = setTimeout(() => {
				this.#pending.delete(userId)
				reject(new Error(`Animation "${animation}" timed out after ${COMMAND_TIMEOUT_MS / 1000}s`))
			}, COMMAND_TIMEOUT_MS)
			// `animation` is kept so a pending command can be re-sent to a replacement
			// connection (browser reload / StrictMode remount) instead of failing.
			this.#pending.set(userId, { resolve, reject, timer, animation })
			ws.send(JSON.stringify({ type: 'soldier_command', payload: { animation } }))
		})
	}

	/**
	 * @param {import('ws').WebSocket} ws
	 * @param {http.IncomingMessage} req
	 */
	#onConnection(ws, req) {
		const userId = this.#parseUserId(req.url)
		if (!userId) {
			ws.close(4001, 'Connection URL must be /ws/<userId>')
			return
		}

		// A browser reload / StrictMode remount opens a fresh socket before the old
		// one's close fires. Point future commands at the newest connection.
		const existing = this.#connections.get(userId)
		this.#connections.set(userId, ws)
		console.error(`[soldier-mcp] Avatar connected: userId=${userId}`)

		if (existing && existing !== ws) {
			// The new socket is the same userId / same browser / same
			// window.playAnimation. Rather than failing an in-flight command (the
			// avatar may already be playing it), hand it off: re-send to the new
			// connection so its soldier_result settles the still-pending promise.
			// The command's timeout keeps running, so a handoff can't extend it.
			const pending = this.#pending.get(userId)
			if (pending) {
				ws.send(
					JSON.stringify({ type: 'soldier_command', payload: { animation: pending.animation } })
				)
			}
			existing.close(4002, 'Replaced by a new connection')
		}

		ws.on('message', (/** @type {Buffer} */ rawData) => {
			/** @type {{ type?: string, payload?: { result?: string } }} */
			let msg
			try {
				msg = JSON.parse(rawData.toString('utf-8'))
			} catch {
				return
			}
			if (msg.type === 'soldier_result') {
				const pending = this.#pending.get(userId)
				if (pending) {
					this.#pending.delete(userId)
					clearTimeout(pending.timer)
					pending.resolve(msg.payload?.result ?? '')
				}
			}
		})

		ws.on('close', () => {
			// Only clear if this exact socket is still the registered one; a newer
			// connection may have already replaced it above.
			if (this.#connections.get(userId) === ws) {
				this.#connections.delete(userId)
				this.#rejectPending(userId, new Error('Avatar disconnected while command was pending'))
				console.error(`[soldier-mcp] Avatar disconnected: userId=${userId}`)
			}
		})
	}

	/**
	 * Extract `<userId>` from a `/ws/<userId>` request path.
	 * @param {string | undefined} url
	 * @returns {string | null}
	 */
	#parseUserId(url) {
		if (!url) return null
		// Strip any query string; the path shape is /ws/<userId>.
		const path = url.split('?')[0]
		const match = /^\/ws\/(.+)$/.exec(path)
		if (!match) return null
		return decodeURIComponent(match[1])
	}

	/**
	 * @param {string} userId
	 * @param {Error} err
	 */
	#rejectPending(userId, err) {
		const pending = this.#pending.get(userId)
		if (pending) {
			this.#pending.delete(userId)
			clearTimeout(pending.timer)
			pending.reject(err)
		}
	}
}
