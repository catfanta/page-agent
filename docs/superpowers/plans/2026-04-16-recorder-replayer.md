# 录制与回放功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@page-agent/recorder` 包，实现用户操作录制、IndexedDB 持久化与回放功能，并在 Panel UI 中增加"录制"标签页。

**Architecture:** 新建独立 monorepo 包 `packages/recorder`，包含 `Recorder`（事件监听+索引映射）、`Replayer`（带模糊匹配的回放执行器）和 `RecordingStore`（IndexedDB CRUD）三个类。UI 侧在 `@page-agent/ui` 的 Panel 中新增 tab 切换机制和 `RecordingTab` 子类。`PageController` 仅新增一个 `getSelectorMap()` 公开方法。

**Tech Stack:** TypeScript ESM、原生 IndexedDB API、原生 DOM 事件、CSS Modules、`@page-agent/page-controller` peer dep。

---

## 文件清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `packages/recorder/package.json` | 包配置，peer dep: page-controller |
| `packages/recorder/tsconfig.json` | 继承 `../../tsconfig.base.json` |
| `packages/recorder/src/types.ts` | `ActionRecord`, `Recording` 类型定义 |
| `packages/recorder/src/RecordingStore.ts` | IndexedDB 单例，CRUD |
| `packages/recorder/src/Recorder.ts` | 事件监听，xpathMap，ActionRecord 生成 |
| `packages/recorder/src/Replayer.ts` | 回放执行，模糊匹配，MutationObserver 等待 |
| `packages/recorder/src/index.ts` | 统一导出 |
| `packages/ui/src/panel/RecordingTab.ts` | 录制标签页 UI 类 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `package.json`（根） | workspaces 数组添加 `packages/recorder` |
| `packages/page-controller/src/PageController.ts` | 新增 `getSelectorMap()` 公开方法 |
| `packages/ui/src/i18n/locales.ts` | 新增 `ui.recording.*` 翻译键 |
| `packages/ui/src/panel/Panel.ts` | 新增 tab 切换机制 + 接入 RecordingTab |
| `packages/ui/src/panel/Panel.module.css` | 新增 tab 样式 |
| `packages/ui/src/index.ts` | 导出 `RecordingPanelConfig` |

---

## Task 1: 创建 `packages/recorder` 包骨架

**Files:**
- Create: `packages/recorder/package.json`
- Create: `packages/recorder/tsconfig.json`
- Create: `packages/recorder/src/types.ts`
- Create: `packages/recorder/src/index.ts`
- Modify: `package.json`（根）

- [ ] **Step 1: 创建 `packages/recorder/package.json`**

```json
{
    "name": "@page-agent/recorder",
    "version": "1.8.0",
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": {
        ".": {
            "types": "./src/index.ts",
            "default": "./src/index.ts"
        }
    },
    "publishConfig": {
        "main": "./dist/lib/recorder.js",
        "module": "./dist/lib/recorder.js",
        "types": "./dist/lib/index.d.ts",
        "exports": {
            ".": {
                "types": "./dist/lib/index.d.ts",
                "import": "./dist/lib/recorder.js",
                "default": "./dist/lib/recorder.js"
            }
        }
    },
    "files": [
        "dist/"
    ],
    "description": "Recording and replay for page-agent - capture user interactions and replay them",
    "keywords": [
        "page-agent",
        "recorder",
        "replay",
        "automation"
    ],
    "author": "Simon<gaomeng1900>",
    "license": "MIT",
    "repository": {
        "type": "git",
        "url": "https://github.com/alibaba/page-agent.git",
        "directory": "packages/recorder"
    },
    "homepage": "https://alibaba.github.io/page-agent/",
    "scripts": {
        "build": "vite build"
    },
    "peerDependencies": {
        "@page-agent/page-controller": "*"
    }
}
```

- [ ] **Step 2: 创建 `packages/recorder/tsconfig.json`**

```json
{
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
        "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.tsbuildinfo"
    },
    "include": ["**/*.ts"],
    "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 `packages/recorder/src/types.ts`**

```ts
export type ActionRecord =
	| { type: 'click'; xpath: string; elementDesc: string }
	| { type: 'input'; xpath: string; elementDesc: string; text: string }
	| { type: 'select'; xpath: string; elementDesc: string; option: string }
	| { type: 'scroll'; down: boolean; pixels: number; xpath?: string }
	| { type: 'navigate'; url: string }

export interface Recording {
	id: string
	name: string
	url: string
	createdAt: number
	actions: ActionRecord[]
}
```

- [ ] **Step 4: 创建 `packages/recorder/src/index.ts`（暂时空）**

```ts
export type { ActionRecord, Recording } from './types'
export { RecordingStore } from './RecordingStore'
export { Recorder } from './Recorder'
export { Replayer } from './Replayer'
```

- [ ] **Step 5: 将 `packages/recorder` 加入根 `package.json` 的 workspaces**

打开 `/Users/xuzhiwen/Downloads/Projects/page-agent/package.json`，在 `workspaces` 数组中加入 `"packages/recorder"`：

```json
"workspaces": [
    "packages/page-controller",
    "packages/ui",
    "packages/llms",
    "packages/core",
    "packages/page-agent",
    "packages/mcp",
    "packages/recorder",
    "packages/extension",
    "packages/website"
]
```

- [ ] **Step 6: 安装依赖，验证工作区识别正确**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm install
npm ls @page-agent/page-controller --workspace=@page-agent/recorder
```

期望输出：列出 page-controller 包，无 error。

- [ ] **Step 7: Commit**

```bash
git add packages/recorder/ package.json package-lock.json
git commit -m "feat(recorder): scaffold @page-agent/recorder package"
```

---

## Task 2: 在 `PageController` 暴露 `getSelectorMap()`

**Files:**
- Modify: `packages/page-controller/src/PageController.ts`

- [ ] **Step 1: 在 `PageController` 的 `// ======= Element Actions =======` 注释上方添加方法**

在 `packages/page-controller/src/PageController.ts` 的 `assertIndexed()` 方法后（第 238 行附近），添加：

```ts
/**
 * Get the current selector map (index → interactive element node).
 * Used by external tools like Recorder/Replayer.
 */
getSelectorMap(): ReadonlyMap<number, InteractiveElementDomNode> {
    return this.selectorMap
}
```

- [ ] **Step 2: 验证类型检查通过**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 3: Commit**

```bash
git add packages/page-controller/src/PageController.ts
git commit -m "feat(page-controller): expose getSelectorMap() as public method"
```

---

## Task 3: 实现 `RecordingStore`（IndexedDB）

**Files:**
- Create: `packages/recorder/src/RecordingStore.ts`

- [ ] **Step 1: 创建 `packages/recorder/src/RecordingStore.ts`**

```ts
import type { Recording } from './types'

const DB_NAME = 'page-agent-recordings'
const STORE_NAME = 'recordings'
const DB_VERSION = 1

/**
 * IndexedDB-backed store for recordings.
 * Singleton: use RecordingStore.getInstance().
 */
export class RecordingStore {
	private static instance: RecordingStore | null = null
	private db: IDBDatabase | null = null

	private constructor() {}

	static getInstance(): RecordingStore {
		if (!RecordingStore.instance) {
			RecordingStore.instance = new RecordingStore()
		}
		return RecordingStore.instance
	}

	private getDb(): Promise<IDBDatabase> {
		if (this.db) return Promise.resolve(this.db)
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VERSION)
			req.onupgradeneeded = (e) => {
				const db = (e.target as IDBOpenDBRequest).result
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
					store.createIndex('createdAt', 'createdAt', { unique: false })
				}
			}
			req.onsuccess = (e) => {
				this.db = (e.target as IDBOpenDBRequest).result
				resolve(this.db)
			}
			req.onerror = () => reject(req.error)
		})
	}

	async save(recording: Recording): Promise<void> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			tx.objectStore(STORE_NAME).put(recording)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}

	/** Returns all recordings sorted by createdAt descending (newest first). */
	async list(): Promise<Recording[]> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly')
			const req = tx.objectStore(STORE_NAME).index('createdAt').getAll()
			req.onsuccess = () => resolve((req.result as Recording[]).reverse())
			req.onerror = () => reject(req.error)
		})
	}

	async get(id: string): Promise<Recording | undefined> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
			req.onsuccess = () => resolve(req.result as Recording | undefined)
			req.onerror = () => reject(req.error)
		})
	}

	async delete(id: string): Promise<void> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			tx.objectStore(STORE_NAME).delete(id)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}

	async rename(id: string, name: string): Promise<void> {
		const recording = await this.get(id)
		if (!recording) throw new Error(`Recording "${id}" not found`)
		await this.save({ ...recording, name })
	}
}
```

- [ ] **Step 2: 在浏览器控制台验证**

打开任意页面，在控制台执行（替换路径为实际构建后地址，或在 demo 页直接测试）：

```js
// 验证 save / list / delete 流程
const store = RecordingStore.getInstance()
await store.save({ id: 'test-1', name: 'Test', url: 'http://localhost', createdAt: Date.now(), actions: [] })
const list = await store.list()
console.assert(list.length === 1, 'should have 1 recording')
console.assert(list[0].id === 'test-1', 'id should match')
await store.delete('test-1')
const list2 = await store.list()
console.assert(list2.length === 0, 'should be empty after delete')
console.log('RecordingStore: all assertions passed')
```

- [ ] **Step 3: Commit**

```bash
git add packages/recorder/src/RecordingStore.ts
git commit -m "feat(recorder): implement RecordingStore with IndexedDB"
```

---

## Task 4: 实现 `Recorder`

**Files:**
- Create: `packages/recorder/src/Recorder.ts`

- [ ] **Step 1: 创建 `packages/recorder/src/Recorder.ts`**

```ts
import type { InteractiveElementDomNode } from '@page-agent/page-controller'
import type { PageController } from '@page-agent/page-controller'

import type { ActionRecord, Recording } from './types'

/**
 * Recorder listens to native user events and converts them to ActionRecords.
 * Call start() to begin, stop() to end and retrieve the Recording.
 * Does NOT persist — caller is responsible for saving via RecordingStore.
 */
export class Recorder {
	private controller: PageController
	private xpathMap = new Map<HTMLElement, string>()
	private descMap = new Map<HTMLElement, string>()
	private actions: ActionRecord[] = []
	private active = false
	private startTime = 0

	constructor(controller: PageController) {
		this.controller = controller
	}

	async start(): Promise<void> {
		if (this.active) return
		this.active = true
		this.actions = []
		this.startTime = Date.now()

		await this.refreshIndex()

		document.addEventListener('click', this.onUserClick, { capture: true })
		document.addEventListener('change', this.onUserChange, { capture: true })
		document.addEventListener('scroll', this.onUserScroll, { capture: true, passive: true })
		window.addEventListener('popstate', this.onNavigate)
		window.addEventListener('hashchange', this.onNavigate)

		const nav = (window as any).navigation
		if (nav?.addEventListener) nav.addEventListener('navigate', this.onNavigate)
	}

	stop(): Recording {
		if (!this.active) {
			throw new Error('Recorder is not active. Call start() first.')
		}
		this.active = false

		document.removeEventListener('click', this.onUserClick, { capture: true })
		document.removeEventListener('change', this.onUserChange, { capture: true })
		document.removeEventListener('scroll', this.onUserScroll, { capture: true })
		window.removeEventListener('popstate', this.onNavigate)
		window.removeEventListener('hashchange', this.onNavigate)

		const nav = (window as any).navigation
		if (nav?.removeEventListener) nav.removeEventListener('navigate', this.onNavigate)

		return {
			id: crypto.randomUUID(),
			name: document.title || 'Recording',
			url: window.location.href,
			createdAt: this.startTime,
			actions: [...this.actions],
		}
	}

	get isActive(): boolean {
		return this.active
	}

	/** Snapshot of current recorded actions (read-only). */
	get recordedActions(): readonly ActionRecord[] {
		return this.actions
	}

	private async refreshIndex(): Promise<void> {
		await this.controller.updateTree()
		this.xpathMap.clear()
		this.descMap.clear()

		for (const [, node] of this.controller.getSelectorMap()) {
			const el = (node as InteractiveElementDomNode).ref as HTMLElement
			const xpath = (node as InteractiveElementDomNode).xpath
			if (!xpath || !el) continue

			this.xpathMap.set(el, xpath)

			const text = el.textContent?.trim().slice(0, 40) ?? ''
			const aria = el.getAttribute('aria-label') ?? ''
			const placeholder = (el as HTMLInputElement).placeholder ?? ''
			const hint = aria || placeholder
			const tagName = (node as InteractiveElementDomNode).tagName ?? el.tagName.toLowerCase()
			this.descMap.set(el, `${tagName}${hint ? `[aria-label=${hint}]` : ''} "${text}"`)
		}
	}

	private findXpath(el: HTMLElement): { xpath: string; desc: string } | undefined {
		let current: HTMLElement | null = el
		while (current) {
			const xpath = this.xpathMap.get(current)
			if (xpath !== undefined) {
				return { xpath, desc: this.descMap.get(current) ?? xpath }
			}
			current = current.parentElement
		}
		return undefined
	}

	private onUserClick = async (e: MouseEvent): Promise<void> => {
		if (!this.active) return
		const target = e.target as HTMLElement
		const found = this.findXpath(target)
		if (!found) return

		this.actions.push({ type: 'click', xpath: found.xpath, elementDesc: found.desc })
		await this.refreshIndex()
	}

	private onUserChange = async (e: Event): Promise<void> => {
		if (!this.active) return
		const el = e.target as HTMLElement
		const found = this.findXpath(el)
		if (!found) return

		if (el instanceof HTMLSelectElement) {
			const option = el.options[el.selectedIndex]?.text ?? ''
			this.actions.push({ type: 'select', xpath: found.xpath, elementDesc: found.desc, option })
		} else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			this.actions.push({ type: 'input', xpath: found.xpath, elementDesc: found.desc, text: el.value })
		}

		await this.refreshIndex()
	}

	private onUserScroll = (e: Event): void => {
		if (!this.active) return
		const el = e.target as HTMLElement | Document
		const isPage =
			el === document || el === document.documentElement || el === document.body
		const pixels = isPage ? window.scrollY : (el as HTMLElement).scrollTop
		const found = isPage ? undefined : this.findXpath(el as HTMLElement)

		this.actions.push({ type: 'scroll', down: true, pixels, xpath: found?.xpath })
	}

	private onNavigate = async (): Promise<void> => {
		if (!this.active) return
		this.actions.push({ type: 'navigate', url: window.location.href })
		await this.refreshIndex()
	}
}
```

- [ ] **Step 2: 验证类型检查通过**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 3: Commit**

```bash
git add packages/recorder/src/Recorder.ts
git commit -m "feat(recorder): implement Recorder class with event capture"
```

---

## Task 5: 实现 `Replayer`

**Files:**
- Create: `packages/recorder/src/Replayer.ts`

- [ ] **Step 1: 创建 `packages/recorder/src/Replayer.ts`**

```ts
import type { InteractiveElementDomNode } from '@page-agent/page-controller'
import type { PageController } from '@page-agent/page-controller'

import type { ActionRecord, Recording } from './types'

type ReplayerEventMap = {
	'step:start': { index: number; action: ActionRecord }
	'step:done': { index: number; action: ActionRecord }
	'step:failed': { index: number; action: ActionRecord; reason: string }
	'replay:done': Record<string, never>
}

type Listener<K extends keyof ReplayerEventMap> = (data: ReplayerEventMap[K]) => void

/**
 * Replayer takes a Recording and executes each ActionRecord via PageController.
 * Element lookup: exact xpath match first, then fuzzy score ≥ 0.8 fallback.
 * On failure to locate an element, emits 'step:failed' and stops replay.
 */
export class Replayer {
	private controller: PageController
	private listeners = new Map<string, Set<Listener<any>>>()
	private aborted = false

	constructor(controller: PageController) {
		this.controller = controller
	}

	on<K extends keyof ReplayerEventMap>(event: K, listener: Listener<K>): this {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set())
		this.listeners.get(event)!.add(listener as Listener<any>)
		return this
	}

	off<K extends keyof ReplayerEventMap>(event: K, listener: Listener<K>): this {
		this.listeners.get(event)?.delete(listener as Listener<any>)
		return this
	}

	/** Stop an in-progress replay after the current step finishes. */
	abort(): void {
		this.aborted = true
	}

	async replay(recording: Recording): Promise<void> {
		this.aborted = false

		for (let i = 0; i < recording.actions.length; i++) {
			if (this.aborted) break

			const action = recording.actions[i]
			this.emit('step:start', { index: i, action })

			// navigate: just wait for DOM to settle (SPA route change already happened during recording)
			if (action.type === 'navigate') {
				await this.waitForDomSettle()
				this.emit('step:done', { index: i, action })
				continue
			}

			await this.controller.updateTree()

			const xpath = 'xpath' in action ? action.xpath : undefined
			let index = xpath !== undefined ? this.findByXpath(xpath) : undefined
			if (index === undefined) {
				index = this.fuzzyMatch(action)
			}

			if (index === undefined) {
				this.emit('step:failed', {
					index: i,
					action,
					reason: `Element not found: ${xpath ?? JSON.stringify(action)}`,
				})
				return
			}

			await this.executeAction(index, action)
			await this.waitForDomSettle()
			this.emit('step:done', { index: i, action })
		}

		this.emit('replay:done', {})
	}

	private findByXpath(xpath: string): number | undefined {
		for (const [index, node] of this.controller.getSelectorMap()) {
			if ((node as InteractiveElementDomNode).xpath === xpath) return index
		}
		return undefined
	}

	private fuzzyMatch(action: ActionRecord): number | undefined {
		if (!('elementDesc' in action)) return undefined
		const desc = action.elementDesc

		// Parse elementDesc: "tagName[aria-label=hint] \"text\""
		const tagName = desc.split(/[\[\s"]/)[0]?.toLowerCase() ?? ''
		const ariaMatch = desc.match(/\[aria-label=([^\]]*)\]/)
		const aria = ariaMatch?.[1]?.toLowerCase().trim() ?? ''
		const textMatch = desc.match(/"([^"]*)"/)
		const text = textMatch?.[1]?.toLowerCase().trim() ?? ''

		let bestScore = 0
		let bestIndex: number | undefined

		for (const [index, node] of this.controller.getSelectorMap()) {
			const el = (node as InteractiveElementDomNode).ref as HTMLElement
			let score = 0

			if ((node as InteractiveElementDomNode).tagName?.toLowerCase() === tagName) score += 0.3

			const elText = el.textContent?.trim().toLowerCase() ?? ''
			if (text && elText.includes(text)) score += 0.4

			const elAria = el.getAttribute('aria-label')?.toLowerCase().trim() ?? ''
			if (aria && elAria === aria) score += 0.1

			const elPlaceholder = (el as HTMLInputElement).placeholder?.toLowerCase().trim() ?? ''
			if (aria && elPlaceholder === aria) score += 0.1

			const elRole = el.getAttribute('role')?.toLowerCase() ?? ''
			if (tagName && elRole === tagName) score += 0.1

			if (score >= 0.8 && score > bestScore) {
				bestScore = score
				bestIndex = index
			}
		}

		return bestIndex
	}

	private async executeAction(index: number, action: ActionRecord): Promise<void> {
		switch (action.type) {
			case 'click':
				await this.controller.clickElement(index)
				break
			case 'input':
				await this.controller.inputText(index, action.text)
				break
			case 'select':
				await this.controller.selectOption(index, action.option)
				break
			case 'scroll': {
				const scrollIndex = action.xpath
					? this.findByXpath(action.xpath)
					: undefined
				await this.controller.scroll({
					down: action.down,
					numPages: 0,
					pixels: action.pixels,
					index: scrollIndex,
				})
				break
			}
		}
	}

	/**
	 * Wait for DOM to stop mutating (300ms silence) or hard cap at 3s.
	 */
	private waitForDomSettle(): Promise<void> {
		return new Promise((resolve) => {
			let silenceTimer: ReturnType<typeof setTimeout>
			const hardCapTimer = setTimeout(done, 3000)

			const observer = new MutationObserver(() => {
				clearTimeout(silenceTimer)
				silenceTimer = setTimeout(done, 300)
			})

			function done() {
				clearTimeout(silenceTimer)
				clearTimeout(hardCapTimer)
				observer.disconnect()
				resolve()
			}

			observer.observe(document.body, { childList: true, subtree: true, attributes: true })
			// Resolve immediately if there are no mutations at all
			silenceTimer = setTimeout(done, 300)
		})
	}

	private emit<K extends keyof ReplayerEventMap>(event: K, data: ReplayerEventMap[K]): void {
		this.listeners.get(event)?.forEach((fn) => fn(data))
	}
}
```

- [ ] **Step 2: 验证类型检查通过**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 3: Commit**

```bash
git add packages/recorder/src/Replayer.ts
git commit -m "feat(recorder): implement Replayer with xpath and fuzzy element matching"
```

---

## Task 6: 为录制 UI 添加 i18n 键

**Files:**
- Modify: `packages/ui/src/i18n/locales.ts`

- [ ] **Step 1: 在 `enUS` 对象的 `ui` 下添加 `recording` 节**

在 `packages/ui/src/i18n/locales.ts` 的 `enUS` 对象里，`tools:` 块之后追加：

```ts
		recording: {
			tab: 'Recording',
			startRecording: 'Start Recording',
			stopRecording: 'Stop Recording',
			recordingStatus: 'Recording...',
			noRecordings: 'No recordings yet',
			replay: 'Replay',
			delete: 'Delete',
			confirmDelete: 'Delete this recording?',
			replayFailed: 'Replay failed at step {{step}}: {{reason}}',
			replayDone: 'Replay completed',
		},
```

在 `zhCN` 对象的对应位置追加：

```ts
		recording: {
			tab: '录制',
			startRecording: '开始录制',
			stopRecording: '停止录制',
			recordingStatus: '录制中...',
			noRecordings: '暂无录制',
			replay: '回放',
			delete: '删除',
			confirmDelete: '删除此录制？',
			replayFailed: '回放在步骤 {{step}} 失败：{{reason}}',
			replayDone: '回放完成',
		},
```

- [ ] **Step 2: 验证类型检查（TranslationKey 类型应自动推导新键）**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/i18n/locales.ts
git commit -m "feat(ui): add recording i18n keys for en-US and zh-CN"
```

---

## Task 7: 实现 `RecordingTab` UI 类

**Files:**
- Create: `packages/ui/src/panel/RecordingTab.ts`

- [ ] **Step 1: 创建 `packages/ui/src/panel/RecordingTab.ts`**

```ts
import type { Recorder, Recording, RecordingStore, Replayer } from '@page-agent/recorder'

import type { I18n } from '../i18n'

export interface RecordingTabDeps {
	recorder: Recorder
	replayer: Replayer
	store: RecordingStore
	i18n: I18n
}

/**
 * RecordingTab manages the DOM for the "Recording" tab content.
 * It owns no state beyond what it renders — state lives in Recorder/Replayer/Store.
 */
export class RecordingTab {
	private deps: RecordingTabDeps
	private root: HTMLElement
	private controlsEl!: HTMLElement
	private previewEl!: HTMLElement
	private historyEl!: HTMLElement
	private statusEl!: HTMLElement
	private startStopBtn!: HTMLButtonElement

	constructor(deps: RecordingTabDeps) {
		this.deps = deps
		this.root = document.createElement('div')
		this.root.className = 'pa-recording-tab'
		this.buildDOM()
		this.wireEvents()
	}

	get element(): HTMLElement {
		return this.root
	}

	/** Call when tab becomes visible to refresh saved recordings list */
	async refresh(): Promise<void> {
		await this.renderHistory()
	}

	private buildDOM(): void {
		const { i18n } = this.deps
		this.root.innerHTML = `
			<div class="pa-rec-controls">
				<span class="pa-rec-status"></span>
				<button class="pa-rec-btn pa-rec-start-stop">${i18n.t('ui.recording.startRecording')}</button>
			</div>
			<div class="pa-rec-preview" style="display:none">
				<div class="pa-rec-preview-list"></div>
			</div>
			<div class="pa-rec-history">
				<div class="pa-rec-history-list"></div>
			</div>
		`

		this.controlsEl = this.root.querySelector('.pa-rec-controls')!
		this.statusEl = this.root.querySelector('.pa-rec-status')!
		this.startStopBtn = this.root.querySelector<HTMLButtonElement>('.pa-rec-start-stop')!
		this.previewEl = this.root.querySelector('.pa-rec-preview')!
		this.historyEl = this.root.querySelector('.pa-rec-history-list')!
	}

	private wireEvents(): void {
		const { recorder, replayer, store, i18n } = this.deps

		this.startStopBtn.addEventListener('click', async () => {
			if (!recorder.isActive) {
				await recorder.start()
				this.setRecordingState(true)
				this.startLivePreview()
			} else {
				const recording = recorder.stop()
				await store.save(recording)
				this.setRecordingState(false)
				this.stopLivePreview()
				await this.renderHistory()
			}
		})

		replayer.on('step:failed', ({ index, reason }) => {
			this.statusEl.textContent = i18n.t('ui.recording.replayFailed', {
				step: String(index + 1),
				reason,
			})
		})
		replayer.on('replay:done', () => {
			this.statusEl.textContent = i18n.t('ui.recording.replayDone')
		})
	}

	private setRecordingState(recording: boolean): void {
		const { i18n } = this.deps
		if (recording) {
			this.startStopBtn.textContent = i18n.t('ui.recording.stopRecording')
			this.startStopBtn.classList.add('pa-rec-active')
			this.statusEl.textContent = i18n.t('ui.recording.recordingStatus')
			this.previewEl.style.display = 'block'
		} else {
			this.startStopBtn.textContent = i18n.t('ui.recording.startRecording')
			this.startStopBtn.classList.remove('pa-rec-active')
			this.statusEl.textContent = ''
			this.previewEl.style.display = 'none'
		}
	}

	private livePreviewTimer: ReturnType<typeof setInterval> | null = null

	private startLivePreview(): void {
		const previewList = this.previewEl.querySelector('.pa-rec-preview-list')!
		this.livePreviewTimer = setInterval(() => {
			const actions = this.deps.recorder.recordedActions
			previewList.innerHTML = actions
				.map((a, i) => {
					const desc =
						'elementDesc' in a
							? a.elementDesc
							: 'url' in a
								? a.url
								: `scroll ${a.down ? '↓' : '↑'} ${a.pixels}px`
					return `<div class="pa-rec-action-row">[${i}] ${a.type} &nbsp;<span class="pa-rec-action-desc">${desc}</span></div>`
				})
				.join('')
		}, 500)
	}

	private stopLivePreview(): void {
		if (this.livePreviewTimer) {
			clearInterval(this.livePreviewTimer)
			this.livePreviewTimer = null
		}
	}

	private async renderHistory(): Promise<void> {
		const { store, replayer, i18n } = this.deps
		const recordings = await store.list()

		if (recordings.length === 0) {
			this.historyEl.innerHTML = `<div class="pa-rec-empty">${i18n.t('ui.recording.noRecordings')}</div>`
			return
		}

		this.historyEl.innerHTML = recordings
			.map((r) => {
				const date = new Date(r.createdAt).toLocaleDateString()
				return `
					<div class="pa-rec-item" data-id="${r.id}">
						<span class="pa-rec-item-name">${r.name}</span>
						<span class="pa-rec-item-date">${date}</span>
						<button class="pa-rec-btn pa-rec-play" data-id="${r.id}" title="${i18n.t('ui.recording.replay')}">▶</button>
						<button class="pa-rec-btn pa-rec-del" data-id="${r.id}" title="${i18n.t('ui.recording.delete')}">🗑</button>
					</div>
				`
			})
			.join('')

		// Wire play buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-play').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id!
				const recording = await store.get(id)
				if (!recording) return
				this.statusEl.textContent = ''
				await replayer.replay(recording)
			})
		})

		// Wire delete buttons
		this.historyEl.querySelectorAll<HTMLButtonElement>('.pa-rec-del').forEach((btn) => {
			btn.addEventListener('click', async () => {
				if (!confirm(i18n.t('ui.recording.confirmDelete'))) return
				await store.delete(btn.dataset.id!)
				await this.renderHistory()
			})
		})
	}
}
```

- [ ] **Step 2: 验证类型检查**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/panel/RecordingTab.ts
git commit -m "feat(ui): implement RecordingTab UI class"
```

---

## Task 8: 将 Tab 切换机制和录制标签接入 Panel

**Files:**
- Modify: `packages/ui/src/panel/Panel.ts`
- Modify: `packages/ui/src/panel/Panel.module.css`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: 在 Panel.module.css 末尾追加 Tab 和录制样式**

在 `packages/ui/src/panel/Panel.module.css` 文件末尾追加：

```css
/* ======= Tab bar ======= */
.tabBar {
	display: flex;
	border-bottom: 1px solid rgba(255, 255, 255, 0.15);
	padding: 0 8px;
	flex-shrink: 0;
}

.tabBtn {
	background: none;
	border: none;
	color: rgba(255, 255, 255, 0.5);
	font-size: 11px;
	padding: 6px 10px;
	cursor: pointer;
	border-bottom: 2px solid transparent;
	transition: all 0.15s;
}

.tabBtn:hover {
	color: rgba(255, 255, 255, 0.8);
}

.tabBtnActive {
	color: rgb(57, 182, 255);
	border-bottom-color: rgb(57, 182, 255);
}

.tabContent {
	display: none;
	overflow-y: auto;
	scrollbar-width: none;
	max-height: 0;
	padding-inline: 8px;
	transition: max-height 0.2s;
}

.tabContent.tabContentActive {
	display: block;
}

.expanded .tabContent.tabContentActive {
	max-height: min(500px, calc(100vh - 200px - var(--height)));
}
```

- [ ] **Step 2: 创建独立的 `RecordingTab.css`（非 CSS Module，全局样式）**

> **原因：** `Panel.module.css` 是 CSS Module，Vite 会对所有选择器哈希处理（`.pa-rec-controls` → `.pa-rec-controls_abc123`），但 `RecordingTab.ts` 用 `className = 'pa-rec-controls'` 写死了类名，无法匹配哈希后的结果。因此需要单独的全局 CSS 文件。

创建 `packages/ui/src/panel/RecordingTab.css`（注意：`.css` 而非 `.module.css`）：

```css
/* Recording Tab global styles — pa-rec- prefix avoids collisions */
.pa-rec-controls {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 0 4px;
}

.pa-rec-status {
	font-size: 11px;
	color: rgb(255, 100, 100);
	flex: 1;
}

.pa-rec-btn {
	background: rgba(255, 255, 255, 0.1);
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 6px;
	color: white;
	font-size: 11px;
	padding: 3px 8px;
	cursor: pointer;
}

.pa-rec-btn:hover {
	background: rgba(255, 255, 255, 0.2);
}

.pa-rec-active {
	background: rgba(255, 60, 60, 0.3) !important;
	border-color: rgb(255, 60, 60) !important;
}

.pa-rec-preview {
	margin-bottom: 6px;
}

.pa-rec-action-row {
	font-size: 11px;
	color: rgba(255, 255, 255, 0.8);
	padding: 2px 0;
}

.pa-rec-action-desc {
	color: rgba(255, 255, 255, 0.5);
	font-size: 10px;
}

.pa-rec-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 0;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	font-size: 11px;
	color: white;
}

.pa-rec-item-name {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.pa-rec-item-date {
	color: rgba(255, 255, 255, 0.4);
	font-size: 10px;
}

.pa-rec-empty {
	font-size: 11px;
	color: rgba(255, 255, 255, 0.4);
	padding: 12px 0;
	text-align: center;
}

.pa-rec-play,
.pa-rec-del {
	padding: 2px 6px;
	font-size: 11px;
}
```

然后在 `packages/ui/src/panel/RecordingTab.ts` 文件顶部（`import` 区，已在 Task 7 Step 1 创建）的末尾追加：

```ts
import './RecordingTab.css'
```

- [ ] **Step 3: 修改 `Panel.ts`，添加 tab 支持和 RecordingTab 接入**

在 `packages/ui/src/panel/Panel.ts` 做以下修改：

**3a. 在文件顶部添加 import（在现有 import 之后）：**

```ts
import type { Recorder, RecordingStore, Replayer } from '@page-agent/recorder'

import type { RecordingTabDeps } from './RecordingTab'
import { RecordingTab } from './RecordingTab'
```

**3b. 在 `PanelConfig` 接口中添加 `recording` 字段（在 `promptForNextTask` 之后）：**

```ts
/**
 * Optional recording/replay dependencies.
 * When provided, a "Recording" tab is added to the panel.
 */
recording?: {
    recorder: Recorder
    replayer: Replayer
    store: RecordingStore
}
```

**3c. 在 `Panel` 类私有字段区添加新字段（在 `#isAnimating` 之后）：**

```ts
#activeTab: 'ai' | 'recording' = 'ai'
#recordingTab: RecordingTab | null = null
#tabBar: HTMLElement | null = null
#aiTabContent: HTMLElement | null = null
#recordingTabContent: HTMLElement | null = null
```

**3d. 在 `constructor` 中，`this.#showInputArea()` 之后追加初始化录制 Tab 的代码：**

```ts
if (config.recording) {
    this.#initRecordingTab(config.recording)
}
```

**3e. 在 `Panel` 类中添加 `#initRecordingTab` 私有方法（放在 `#createWrapper` 方法之前）：**

```ts
#initRecordingTab(cfg: NonNullable<PanelConfig['recording']>): void {
    // Create tab bar
    const tabBar = document.createElement('div')
    tabBar.className = styles.tabBar
    tabBar.innerHTML = `
        <button class="${styles.tabBtn} ${styles.tabBtnActive}" data-tab="ai">AI</button>
        <button class="${styles.tabBtn}" data-tab="recording">${this.#i18n.t('ui.recording.tab')}</button>
    `
    this.#tabBar = tabBar

    // Wrap existing historySection in a tabContent div
    const aiContent = document.createElement('div')
    aiContent.className = `${styles.tabContent} ${styles.tabContentActive}`
    const historySectionWrapper = this.#wrapper.querySelector(`.${styles.historySectionWrapper}`)!
    // Move historySection into aiContent
    const existingHistorySection = this.#historySection
    existingHistorySection.parentElement?.removeChild(existingHistorySection)
    aiContent.appendChild(existingHistorySection)
    this.#aiTabContent = aiContent

    // Create recording tab content
    const recordingContent = document.createElement('div')
    recordingContent.className = styles.tabContent
    this.#recordingTabContent = recordingContent

    const deps: RecordingTabDeps = {
        recorder: cfg.recorder,
        replayer: cfg.replayer,
        store: cfg.store,
        i18n: this.#i18n,
    }
    this.#recordingTab = new RecordingTab(deps)
    recordingContent.appendChild(this.#recordingTab.element)

    // Insert tab bar + content into historySectionWrapper
    historySectionWrapper.prepend(tabBar)
    historySectionWrapper.appendChild(aiContent)
    historySectionWrapper.appendChild(recordingContent)

    // Tab switching
    tabBar.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]')
        if (!btn) return
        const tab = btn.dataset.tab as 'ai' | 'recording'
        this.#switchTab(tab)
    })
}

#switchTab(tab: 'ai' | 'recording'): void {
    this.#activeTab = tab

    const tabs = this.#tabBar?.querySelectorAll<HTMLButtonElement>('[data-tab]')
    tabs?.forEach((btn) => {
        btn.classList.toggle(styles.tabBtnActive, btn.dataset.tab === tab)
    })

    this.#aiTabContent?.classList.toggle(styles.tabContentActive, tab === 'ai')
    this.#recordingTabContent?.classList.toggle(styles.tabContentActive, tab === 'recording')

    if (tab === 'recording') {
        void this.#recordingTab?.refresh()
        // Expand panel if collapsed
        if (!this.#isExpanded) this.#expand()
    }
}
```

- [ ] **Step 4: 修改 `#createWrapper` 中的 `historySectionWrapper` HTML**

在 `packages/ui/src/panel/Panel.ts` 的 `#createWrapper()` 方法里，将：

```html
<div class="${styles.historySectionWrapper}">
    <div class="${styles.historySection}">
        <div class="${styles.historyItem}">
```

改为（**保持现有内容，只去掉 `historySectionWrapper` 内的默认 `historySection`**，因为 `#initRecordingTab` 里会重新挂载）：

```html
<div class="${styles.historySectionWrapper}">
    <div class="${styles.historySection}">
        <div class="${styles.historyItem}">
```

> 保持不变即可——`#initRecordingTab` 会在初始化时将 historySection 取出并重新挂载到 aiTabContent 中。当没有 recording 配置时，Panel 行为与现在完全相同。

- [ ] **Step 5: 修改 `packages/ui/src/index.ts`，导出新配置类型**

在 `packages/ui/src/index.ts` 末尾追加：

```ts
export type { RecordingTabDeps } from './panel/RecordingTab'
```

- [ ] **Step 6: 验证类型检查**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望输出：无 error。

- [ ] **Step 7: 端到端验证（在 website demo 或任意页面测试）**

在页面中执行：

```js
import { PageController } from '@page-agent/page-controller'
import { Recorder, Replayer, RecordingStore } from '@page-agent/recorder'
import { Panel } from '@page-agent/ui'

const controller = new PageController()
const recorder = new Recorder(controller)
const replayer = new Replayer(controller)
const store = RecordingStore.getInstance()

// 验证录制流程
await recorder.start()
// 在页面上手动点击几个元素
const recording = recorder.stop()
console.log('Recorded actions:', recording.actions)
console.assert(recording.actions.length > 0, 'Should have captured actions')

// 验证持久化
await store.save(recording)
const list = await store.list()
console.assert(list.length >= 1, 'Should have at least 1 saved recording')

// 验证回放
replayer.on('step:done', ({ index }) => console.log(`Step ${index} done`))
replayer.on('replay:done', () => console.log('Replay complete!'))
replayer.on('step:failed', ({ reason }) => console.error('Failed:', reason))
await replayer.replay(recording)

console.log('All verifications passed')
```

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/panel/Panel.ts packages/ui/src/panel/Panel.module.css packages/ui/src/index.ts
git commit -m "feat(ui): add Recording tab to Panel with tab switching mechanism"
```

---

## Task 9: 最终整合验证

- [ ] **Step 1: 完整类型检查**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run typecheck
```

期望：无 error。

- [ ] **Step 2: Lint 检查**

```bash
cd /Users/xuzhiwen/Downloads/Projects/page-agent
npm run lint
```

期望：无 error（允许 warning）。

- [ ] **Step 3: 最终 Commit**

```bash
git add -A
git commit -m "feat: complete recorder/replayer feature integration"
```

---

## 实现顺序依赖

```
Task 1 (包骨架)
  → Task 2 (getSelectorMap)
      → Task 4 (Recorder)
      → Task 5 (Replayer)
  → Task 3 (RecordingStore)  ← 独立，可并行
  → Task 6 (i18n)            ← 独立，可并行
      → Task 7 (RecordingTab)
          → Task 8 (Panel 接入)
              → Task 9 (验证)
```

Tasks 3、6 可以和 Tasks 4、5 并行进行。
