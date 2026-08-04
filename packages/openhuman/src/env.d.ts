/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_OPENHUMAN_BASE_URL?: string
	readonly VITE_OPENHUMAN_CORE_TOKEN?: string
	readonly VITE_OPENHUMAN_MODEL?: string
	/** Enable demo mode by default (local recording/replay commands bypass the LLM). "true"/"1" to enable. */
	readonly VITE_OPENHUMAN_DEMO_MODE?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
