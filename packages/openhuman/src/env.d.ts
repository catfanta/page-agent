/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_OPENHUMAN_BASE_URL?: string
	readonly VITE_OPENHUMAN_CORE_TOKEN?: string
	readonly VITE_OPENHUMAN_MODEL?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
