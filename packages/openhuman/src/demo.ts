/**
 * IIFE demo entry - injects OpenHumanPanel into any webpage via bookmarklet or script tag.
 * Exposes window.__openhuman for manual control in DevTools.
 *
 * Bookmarklet:
 *   javascript:(function(){var s=document.createElement('script');s.src='http://localhost:5176/openhuman.demo.js?t='+Math.random()+'&baseURL=http://localhost:8642';document.head.appendChild(s);})();
 *
 * URL params (read from script src):
 *   baseURL  — OpenHuman server base URL, e.g. http://localhost:8642
 *   apiKey   — Bearer token for the OpenHuman server
 */
import React from 'react'
import { createRoot } from 'react-dom/client'

import { OpenHumanPanel } from './OpenHumanPanel'

declare global {
	interface Window {
		__openhuman: { unmount: () => void } | undefined
	}
}

// Clean up existing instance to allow re-injection
if (window.__openhuman) {
	try {
		window.__openhuman.unmount()
	} catch {
		// Previous instance may already be in a broken state; proceed with fresh mount
		window.__openhuman = undefined
	}
}

// currentScript is only available synchronously during script execution
const currentScript = document.currentScript as HTMLScriptElement | null
const scriptParams = currentScript ? new URL(currentScript.src).searchParams : null
const baseURL = scriptParams?.get('baseURL') ?? ''
const apiKey = scriptParams?.get('apiKey') ?? ''

// Remove any leftover container from a previous broken injection
document.getElementById('__openhuman-root')?.remove()

const container = document.createElement('div')
container.id = '__openhuman-root'
document.body.appendChild(container)

const root = createRoot(container)

const unmount = () => {
	root.unmount()
	container.remove()
	window.__openhuman = undefined
}

root.render(
	React.createElement(OpenHumanPanel, {
		baseURL: baseURL || undefined,
		apiKey: apiKey || undefined,
		onClose: unmount,
	})
)

window.__openhuman = { unmount }

console.log('🪄 OpenHuman injected.\n' + '  window.__openhuman.unmount() — 卸载 OpenHuman 面板')
