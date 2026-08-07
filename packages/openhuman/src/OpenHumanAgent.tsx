/**
 * OpenHuman agent entry: a trigger button that opens the OpenHumanPanel and
 * mounts the 3D SoldierViewer alongside it.
 *
 * This is the integration point between two independent services:
 *  - OpenHumanPanel — the chat/recording UI wired to the OpenHuman backend.
 *  - SoldierViewer  — a 3D avatar overlay that follows the panel and exposes
 *    `window.playAnimation()` for the agent to react visually.
 *
 * The panel is unmounted while closed (matching its open/close transitions),
 * while SoldierViewer stays mounted and toggles visibility so its three.js
 * scene and the global animation API survive across open/close cycles.
 */
import { useState } from 'react'

import { OpenHumanPanel } from './OpenHumanPanel'
import SoldierViewer from './SoldierViewer'
import { useSoldierSocket } from './hooks/useWebSocket'

/**
 * Default connection id, matching soldier_mcp_server.py's SOLDIER_DEFAULT_USER_ID
 * so a fresh install connects to the right browser without extra config.
 */
const DEFAULT_SOLDIER_USER_ID = '58be57a5-1330-4281-b1d2-cfda6321c327'

interface OpenHumanAgentProps {
	/** OpenHuman server base URL, e.g. 'http://localhost:8080'. */
	baseURL?: string
	/** Bearer token for the OpenHuman server (OPENHUMAN_CORE_TOKEN). */
	apiKey?: string
	/** Model id for chat completions. */
	model?: string
	/** glTF/GLB model URL for the avatar. Defaults to '/soldier.glb'. */
	modelUrl?: string
	/** Start with the panel open. Defaults to false. */
	defaultOpen?: boolean
	/**
	 * WebSocket URL (or base) of the soldier MCP server's embedded hub. When
	 * omitted, useSoldierSocket falls back to VITE_OPENHUMAN_SOLDIER_WS, then to
	 * `ws://localhost:38402/ws/<soldierUserId>`.
	 */
	soldierWsUrl?: string
	/** Connection id the soldier MCP server addresses animation commands to. */
	soldierUserId?: string
}

const TRIGGER_STYLE: React.CSSProperties = {
	position: 'fixed',
	right: '24px',
	bottom: '24px',
	zIndex: 2147483642,
	width: '48px',
	height: '48px',
	borderRadius: '50%',
	border: 'none',
	cursor: 'pointer',
	fontSize: '22px',
	lineHeight: 1,
	color: 'white',
	background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
	boxShadow: '0 4px 16px rgba(99,102,241,0.4)',
}

export const OpenHumanAgent: React.FC<OpenHumanAgentProps> = ({
	baseURL,
	apiKey,
	model,
	modelUrl,
	defaultOpen = false,
	soldierWsUrl,
	soldierUserId = DEFAULT_SOLDIER_USER_ID,
}) => {
	const [open, setOpen] = useState(defaultOpen)

	// Connect directly to the soldier MCP server's WS hub so its play_animation
	// tool drives the on-page avatar (window.playAnimation) with no backend hop.
	useSoldierSocket({ url: soldierWsUrl, userId: soldierUserId })

	return (
		<>
			{!open && (
				<button
					type="button"
					style={TRIGGER_STYLE}
					title="打开 OpenHuman 助手"
					aria-label="打开 OpenHuman 助手"
					onClick={() => setOpen(true)}
				>
					🤖
				</button>
			)}
			<SoldierViewer visible={open} modelUrl={modelUrl} />
			{open && (
				<OpenHumanPanel
					baseURL={baseURL}
					apiKey={apiKey}
					model={model}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	)
}
