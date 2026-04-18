# @page-agent/recorder

用户浏览器操作录制与回放库。监听真实用户交互，输出结构化动作列表，可直接在相同页面或后续会话中回放。

---

## 功能

| 功能 | 说明 |
|------|------|
| 录制用户操作 | 捕获点击、输入、下拉选择、滚动、页面导航 |
| 元素稳定定位 | 优先用元素文本匹配，辅以 aria-label / title / placeholder |
| SPA 导航支持 | 拦截 pushState / replaceState，兼容传统 popstate / hashchange |
| Agent 动作过滤 | setAgentActing() 标志位防止将 PageAgent 合成事件误录为用户操作 |
| 结构化输出 | RecordedStep[] 可直接 JSON 序列化、持久化、传给 Replayer |
| 回放 | Replayer 按步骤顺序重新执行，步骤间可配置延迟 |
| 回放可中止 | replayer.abort() 随时中止 |
| 浏览器注入 | IIFE 构建产物可通过 script 标签或书签脚本注入任意页面 |

---

## 复用的内部包

### @page-agent/page-controller

Recorder 和 Replayer 均依赖 `PageController`，复用其以下能力：

| 方法 | 用途 |
|------|------|
| `updateTree()` | 刷新 DOM 索引，录制每次操作前调用以保证 index 准确 |
| `findIndexByElement(el)` | 将用户点击的 DOM 元素反查为 PageController index |
| `getElementTextSnapshot()` | 获取当前 index → 元素文本的 Map，用于录制存文本、回放时文本匹配 |
| `clickElement(index)` | 回放点击 |
| `inputText(index, text)` | 回放文本输入 |
| `selectOption(index, optionText)` | 回放下拉选择 |
| `scroll({ down, pixels })` | 回放滚动 |
| `cleanUpHighlights()` | stop() 时清除页面辅助框线 |

Recorder / Replayer 本身不做任何 DOM 操作，完全通过 PageController 接口交互。

---

## 数据结构

### RecordedStep

```typescript
interface RecordedStep {
  action: RecordedAction   // 具体操作
  url: string              // 操作时的页面 URL
  timestamp: number        // ms since epoch
}
```

### RecordedAction 联合类型

```typescript
// 点击
{ type: 'click_element_by_index', index, elementText, elementHint? }

// 文本输入
{ type: 'input_text', index, elementText, elementHint?, text }

// 下拉选择
{ type: 'select_dropdown_option', index, elementText, elementHint?, optionText }

// 页面导航
{ type: 'navigate', url }

// 滚动
{ type: 'scroll', down: boolean, pixels: number }
```

**elementText**：PageController 为元素生成的简化 HTML 文本表示，格式如 `[35]<button type=button>加载测试样例 />`。回放时优先用此字段精确匹配。

**elementHint**：元素的 `aria-label` / `title` / `placeholder`，elementText 为空（图标按钮等无文字元素）时的备用定位标识。

---

## 架构

```
用户操作
  │
  ├─ click / change 事件（capture 阶段）
  ├─ scroll 事件（RAF 节流，50px 阈值过滤）
  └─ popstate / hashchange / pushState / replaceState 拦截
          │
          ▼
    Recorder.handleXxx()
          │
          ├─ pageController.updateTree()     ← 刷新 DOM 索引
          ├─ pageController.findIndexByElement()  ← 元素 → index
          ├─ pageController.getElementTextSnapshot()  ← index → 文本
          └─ getElementHint()  ← aria-label / title / placeholder
          │
          ▼
    RecordedStep[]  ──→  onStep 回调 / window.__recorderSteps
          │
          ▼
    Replayer.replay(steps)
          │
          ├─ updateTree()  ← 每步前刷新
          ├─ resolveIndex()  ← 三级匹配（文本 → hint → 原始 index）
          └─ pageController.clickElement / inputText / selectOption / scroll
```

---

## 元素定位策略（Replayer）

回放时 index 可能因 DOM 变化而失效，Replayer 采用三级匹配：

1. **elementText 精确匹配** — 在当前 DOM 的 elementTextMap 中找完全相同的文本，返回当前 index
2. **elementHint 包含匹配** — 在 elementTextMap 中找包含 aria-label / title / placeholder 的条目
3. **降级** — 使用录制时的原始 index，并在控制台打印警告

> 对于完全没有文字标识的元素（elementText 和 elementHint 均为空），建议在页面源码中添加 `aria-label` 属性以提升定位稳定性。

---

## 使用方式

### 作为库引入

```typescript
import { Recorder, Replayer } from '@page-agent/recorder'
import { PageController } from '@page-agent/page-controller'

const controller = new PageController()

// 录制
const recorder = new Recorder(controller, {
  scrollThreshold: 50,           // 最小滚动距离（px），过滤偶然小滑动
  onStep: (step) => console.log(step),
})
recorder.start()

// ... 用户操作页面 ...

recorder.stop()                  // 停止录制，清除页面框线
const steps = recorder.steps    // RecordedStep[]

// 回放
const replayer = new Replayer(controller, {
  stepDelay: 500,                // 步骤间延迟（ms）
  onStepStart: (step, i) => {},
  onStepDone: (step, i, success, msg) => {},
  onDone: (steps) => {},
})
await replayer.replay(steps)
replayer.abort()                 // 中止回放
```

### 浏览器注入（书签脚本 / DevTools）

启动本地服务：

```bash
cd packages/recorder
npm run dev:demo     # 构建 IIFE 并在 http://localhost:5175 提供文件
```

在任意页面的 DevTools Console 执行：

```javascript
var s = document.createElement('script')
s.src = 'http://localhost:5175/recorder.demo.js'
document.head.appendChild(s)
```

注入后可用的全局变量：

| 变量 | 说明 |
|------|------|
| `window.__recorder` | Recorder 实例 |
| `window.__recorderSteps` | 实时录制步骤数组（响应式引用） |
| `window.__replayer` | Replayer 实例 |
| `window.__replay(steps?)` | 回放，不传参数则回放所有已录制步骤 |

常用操作：

```javascript
// 停止录制
window.__recorder.stop()

// 导出步骤 JSON
console.log(JSON.stringify(window.__recorderSteps, null, 2))

// 回放
window.__replay()

// 回放指定步骤
window.__replay(window.__recorderSteps.slice(0, 3))

// 中止回放
window.__replayer.abort()
```

---

## 文件结构

```
packages/recorder/
├── src/
│   ├── types.ts          # 所有类型定义
│   ├── Recorder.ts       # 录制器
│   ├── Replayer.ts       # 回放器
│   ├── demo.ts           # 浏览器注入入口（IIFE）
│   └── index.ts          # 包导出
├── vite.iife.config.js   # IIFE 构建配置
└── package.json
```

---

## 构建

```bash
npm run build:demo   # 生成 dist/iife/recorder.demo.js
npm run dev:demo     # watch 模式 + 本地 serve（端口 5175）
```
