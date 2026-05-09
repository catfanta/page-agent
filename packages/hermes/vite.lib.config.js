// @ts-check
import { dirname, resolve } from 'path'
import dts from 'unplugin-dts/vite'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	clearScreen: false,
	plugins: [
		dts({
			bundleTypes: true,
			exclude: ['src/demo.ts'],
			compilerOptions: {
				composite: true,
				noEmit: false,
				emitDeclarationOnly: true,
				declaration: true,
			},
		}),
		// Panel.module.css and other styles are bundled into JS — consumers need no separate CSS import
		cssInjectedByJsPlugin({ relativeCSSInjection: true }),
	],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'Hermes',
			fileName: 'hermes',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'lib'),
		rollupOptions: {
			// React must be provided by the consumer — externalizing prevents duplicate React instances
			external: ['react', 'react-dom', 'react/jsx-runtime'],
		},
		minify: false,
		sourcemap: true,
		cssCodeSplit: true,
	},
	define: {
		'process.env.NODE_ENV': '"production"',
		// API key must be passed via the apiKey prop in library mode
		'import.meta.env.VITE_HERMES_API_KEY': '""',
	},
})
