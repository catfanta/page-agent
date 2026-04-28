import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			'/api/hermes': {
				target: 'http://localhost:8642',
				rewrite: (path) => path.replace(/^\/api\/hermes/, ''),
				changeOrigin: true,
			},
		},
	},
})
