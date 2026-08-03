/**
 * Minimal CORS proxy for local OpenHuman development.
 *
 * Forwards requests to the OpenHuman backend and injects CORS headers so that
 * pages on foreign origins (e.g. https://rpachallenge.com) can reach the
 * local server when the panel is injected via bookmarklet.
 *
 * Usage: node cors-proxy.mjs
 * Env:   OPENHUMAN_PORT  — upstream port (default 8080)
 *        PROXY_PORT      — proxy listen port (default 5177)
 */
import http from 'http'

const TARGET_PORT = parseInt(process.env.OPENHUMAN_PORT ?? '8080', 10)
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? '5177', 10)

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Expose-Headers': '*',
}

const server = http.createServer((req, res) => {
	// Preflight
	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS_HEADERS)
		res.end()
		return
	}

	// Strip browser-set origin/referer so the upstream server doesn't reject
	// cross-origin requests from injected pages (e.g. https://rpachallenge.com).
	const { origin, referer, ...forwardHeaders } = req.headers
	const options = {
		hostname: 'localhost',
		port: TARGET_PORT,
		path: req.url,
		method: req.method,
		headers: { ...forwardHeaders, host: `localhost:${TARGET_PORT}` },
	}

	console.log(`[proxy] ${req.method} ${req.url}`)

	const proxy = http.request(options, (upstream) => {
		const headers = { ...upstream.headers, ...CORS_HEADERS }
		res.writeHead(upstream.statusCode ?? 200, headers)
		upstream.pipe(res)
	})

	proxy.on('error', (err) => {
		console.error('[cors-proxy] upstream error:', err.message)
		if (!res.headersSent) {
			res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'text/plain' })
		}
		res.end(`Proxy error: ${err.message}`)
	})

	req.pipe(proxy)
})

server.on('error', (err) => {
	if (err.code === 'EADDRINUSE') {
		console.error(
			`[cors-proxy] Port ${PROXY_PORT} already in use. Kill the existing process first:`
		)
		console.error(`  lsof -ti:${PROXY_PORT} | xargs kill`)
		process.exit(1)
	}
	throw err
})

server.listen(PROXY_PORT, () => {
	console.log(`🔀 CORS proxy  http://localhost:${PROXY_PORT} → http://localhost:${TARGET_PORT}`)
})
