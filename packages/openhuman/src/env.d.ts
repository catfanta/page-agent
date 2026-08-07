/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_OPENHUMAN_BASE_URL?: string
	readonly VITE_OPENHUMAN_CORE_TOKEN?: string
	readonly VITE_OPENHUMAN_MODEL?: string
	/** Enable demo mode by default (local recording/replay commands bypass the LLM). "true"/"1" to enable. */
	readonly VITE_OPENHUMAN_DEMO_MODE?: string
	/**
	 * WebSocket URL (or base) of the soldier MCP server's embedded hub, e.g.
	 * `ws://localhost:38402` or `ws://localhost:38402/ws/<userId>`. Consumed by
	 * useSoldierSocket to drive the on-page avatar directly from the MCP server.
	 */
	readonly VITE_OPENHUMAN_SOLDIER_WS?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
