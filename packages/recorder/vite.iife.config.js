// @ts-check
import { config as dotenvConfig } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

dotenvConfig({ path: resolve(__dirname, '../../.env'), quiet: true })

export default defineConfig({
	publicDir: false,
	esbuild: {
		target: 'es2020',
	},
	build: {
		lib: {
			entry: resolve(__dirname, 'src/demo.ts'),
			name: 'PageAgentRecorder',
			fileName: () => 'recorder.demo.js',
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
	resolve: {
		alias: {
			'@page-agent/page-controller': resolve(
				__dirname,
				'../page-controller/src/PageController.ts',
			),
		},
	},
})
