import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			'/api/openhuman': {
				target: 'http://localhost:8080',
				rewrite: (path) => path.replace(/^\/api\/openhuman/, ''),
				changeOrigin: true,
			},
		},
	},
})
