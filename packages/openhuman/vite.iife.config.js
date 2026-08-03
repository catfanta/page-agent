// @ts-check
import react from '@vitejs/plugin-react-swc'
import { config as dotenvConfig } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// .env.local takes priority; root .env is the fallback
dotenvConfig({ path: resolve(__dirname, '.env.local'), quiet: true })
dotenvConfig({ path: resolve(__dirname, '../../.env'), quiet: true })

export default defineConfig({
	plugins: [react(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/demo.ts'),
			name: 'OpenHumanPanel',
			fileName: () => 'openhuman.demo.js',
			formats: ['iife'],
		},
		outDir: resolve(__dirname, 'dist', 'iife'),
		rollupOptions: {
			onwarn(message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify('production'),
		'import.meta.env.VITE_OPENHUMAN_BASE_URL': JSON.stringify(
			process.env.VITE_OPENHUMAN_BASE_URL ?? ''
		),
		'import.meta.env.VITE_OPENHUMAN_CORE_TOKEN': JSON.stringify(
			process.env.VITE_OPENHUMAN_CORE_TOKEN ?? ''
		),
		'import.meta.env.VITE_OPENHUMAN_MODEL': JSON.stringify(process.env.VITE_OPENHUMAN_MODEL ?? ''),
	},
})
