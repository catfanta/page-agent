/**
 * IIFE demo entry - injects HermesPanel into any webpage via bookmarklet or script tag.
 * Exposes window.__hermes for manual control in DevTools.
 *
 * Bookmarklet:
 *   javascript:(function(){var s=document.createElement('script');s.src='http://localhost:5176/hermes.demo.js?t='+Math.random()+'&baseURL=http://localhost:8642';document.head.appendChild(s);})();
 *
 * URL params (read from script src):
 *   baseURL  — Hermes server base URL, e.g. http://localhost:8642
 *   apiKey   — Bearer token for the Hermes server
 */
import React from 'react'
import { createRoot } from 'react-dom/client'

import { HermesPanel } from './HermesPanel'

declare global {
	interface Window {
		__hermes: { unmount: () => void } | undefined
	}
}

// Clean up existing instance to allow re-injection
if (window.__hermes) {
	try {
		window.__hermes.unmount()
	} catch {
		// Previous instance may already be in a broken state; proceed with fresh mount
		window.__hermes = undefined
	}
}

// currentScript is only available synchronously during script execution
const currentScript = document.currentScript as HTMLScriptElement | null
const scriptParams = currentScript ? new URL(currentScript.src).searchParams : null
const baseURL = scriptParams?.get('baseURL') ?? ''
const apiKey = scriptParams?.get('apiKey') ?? ''

// Remove any leftover container from a previous broken injection
document.getElementById('__hermes-root')?.remove()

const container = document.createElement('div')
container.id = '__hermes-root'
document.body.appendChild(container)

const root = createRoot(container)

const unmount = () => {
	root.unmount()
	container.remove()
	window.__hermes = undefined
}

root.render(
	React.createElement(HermesPanel, {
		baseURL: baseURL || undefined,
		apiKey: apiKey || undefined,
		onClose: unmount,
	})
)

window.__hermes = { unmount }

console.log('🪄 Hermes injected.\n' + '  window.__hermes.unmount() — 卸载 Hermes 面板')
