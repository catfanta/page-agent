# @page-agent/hermes

浮层对话面板，可注入任意网页，与 Hermes Agent 后端通信，实现基于上下文的浏览器自动化对话。

---

## 功能

| 功能 | 说明 |
|------|------|
| 对话界面 | 固定在页面底部的浮层面板，支持折叠/展开 |
| 流式响应 | 通过 SSE（Server-Sent Events）实时呈现回复 |
| 会话记忆 | `X-Hermes-Session-Key` 跨刷新保持同一会话，支持后端长期记忆 |
| 书签注入 | IIFE 构建产物可通过 script 标签或书签脚本注入任意页面 |
| 灵活配置 | 通过脚本 URL 参数传入后端地址和鉴权 token |

---

## 架构

```
浏览器页面
└── HermesPanel（React 浮层）
        │  POST /v1/chat/completions（SSE）
        ▼
Hermes Agent 后端（默认 http://localhost:8642）
```

- 开发模式：Vite 将 `/api/hermes/*` 代理到 `http://localhost:8642`，前端无需配置跨域。
- 注入模式：通过脚本 src 的 `baseURL` 参数直接指向后端，面板以完整 URL 发起请求。

### 会话 Key

每个浏览器会话生成一个 UUID 并持久化在 `localStorage('hermes-session-key')`，通过 `X-Hermes-Session-Key` 请求头传给后端，用于支持跨对话的长期记忆。

---

## 开发模式

启动 Vite 开发服务器（端口 5174），同时反向代理 Hermes 后端：

```bash
cd packages/hermes
npm run dev
```

访问 `http://localhost:5174` 即可使用完整对话面板。后端地址通过 `vite.config.ts` 代理配置：

```ts
proxy: {
  '/api/hermes': {
    target: 'http://localhost:8642',
    rewrite: (path) => path.replace(/^\/api\/hermes/, ''),
  },
}
```

如需修改后端端口，在 `vite.config.ts` 中调整 `target`。

---

## 浏览器注入（书签脚本 / DevTools）

### 启动本地文件服务

```bash
cd packages/hermes
npm run dev:demo     # 构建 IIFE 并在 http://localhost:5176 提供文件
```

### 书签脚本（Bookmarklet）

将以下内容存为浏览器书签，点击即可在任意页面注入 Hermes 面板：

```
javascript:(function(){var s=document.createElement('script');s.src='http://localhost:5176/hermes.demo.js?t='+Math.random()+'&baseURL=http://localhost:5177';document.head.appendChild(s);})();
```

或在 DevTools Console 中直接执行：

```javascript
var s = document.createElement('script')
s.src = 'http://localhost:5176/hermes.demo.js?baseURL=http://localhost:5177'
document.head.appendChild(s)
```

> `baseURL` 指向 CORS 代理（5177），而非 Hermes 后端（8642）。代理由 `dev:demo` 自动启动。

### 脚本 URL 参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `baseURL` | CORS 代理地址（不含路径） | `http://localhost:5177` |
| `apiKey` | Bearer token，对应后端鉴权 | `sk-xxx` |

两个参数均为可选。不传 `baseURL` 时面板以相对路径 `/api/hermes/v1/chat/completions` 发请求（适合同源部署）；不传 `apiKey` 时使用构建时内联的 `VITE_HERMES_API_KEY` 环境变量。

### 重复注入

再次执行书签脚本会自动卸载旧实例并重新挂载，无需手动清理。

### 全局 API

注入后可在 DevTools Console 使用：

| 变量 | 说明 |
|------|------|
| `window.__hermes` | Hermes 面板控制对象 |
| `window.__hermes.unmount()` | 卸载面板并从 DOM 中移除 |

---

## 文件结构

```
packages/hermes/
├── src/
│   ├── HermesPanel.tsx      # 对话面板 React 组件
│   ├── demo.ts              # 浏览器注入入口（IIFE）
│   ├── main.tsx             # SPA 开发模式入口
│   ├── index.css            # SPA 全局样式（Tailwind）
│   └── env.d.ts             # Vite 环境变量类型声明
├── cors-proxy.mjs           # 本地 CORS 代理（dev:demo 时自动启动）
├── vite.config.ts           # SPA 开发服务器配置（含代理）
├── vite.iife.config.js      # IIFE 书签注入构建配置
└── package.json
```

---

## 构建

```bash
npm run build:demo   # 生成 dist/iife/hermes.demo.js
npm run dev:demo     # watch 模式 + 文件 serve（5176）+ CORS 代理（5177）
npm run build        # 生成 SPA dist/（用于部署独立页面）
```

> **注意**：`VITE_HERMES_API_KEY` 若在构建时写入 `.env`，会被内联到 IIFE 产物中。分发脚本前确认 token 不敏感。

---

## 常见问题

### `process is not defined`

**现象**：书签注入后 DevTools 报 `Uncaught ReferenceError: process is not defined`，面板无法挂载。

**原因**：React 内部引用了 `process.env.NODE_ENV`，浏览器运行时没有 `process` 全局变量。

**解决**：在 `vite.iife.config.js` 的 `define` 中显式替换：

```js
define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
}
```

---

### CORS 错误（`Access-Control-Allow-Origin`）

**现象**：请求被浏览器拦截，报 `has been blocked by CORS policy`。

**原因**：书签注入后请求从第三方页面的源（如 `https://example.com`）直接打到 `localhost:8642`，浏览器执行同源策略拦截跨域请求。

**解决**：`dev:demo` 启动的 CORS 代理（端口 5177）在转发请求时注入 `Access-Control-Allow-Origin: *` 响应头。书签的 `baseURL` 必须指向代理（5177），而非后端（8642）。

---

### 403 Forbidden

**现象**：CORS 错误消失后改为 403，请求到达后端但被拒绝。

**原因有两种**：

1. **后端做 Origin 校验**：代理把浏览器原始的 `Origin: https://example.com` 头转发给了后端，后端拒绝非预期来源。CORS 代理已在转发时剥离 `origin` 和 `referer` 头。

2. **API key 未内联到 IIFE 产物**：IIFE 构建默认只加载项目根目录的 `.env`，不加载 `packages/hermes/.env.local`，导致 `Authorization` 头为空。已在 `vite.iife.config.js` 中补充加载 `.env.local`（优先级高于根 `.env`）：

   ```js
   dotenvConfig({ path: resolve(__dirname, '.env.local'), quiet: true })
   dotenvConfig({ path: resolve(__dirname, '../../.env'), quiet: true })
   ```

   修改后需重新执行 `npm run build:demo`。

---

### 端口被占用（`EADDRINUSE :5177`）

**现象**：`dev:demo` 启动时 cors-proxy 进程报错退出。

**原因**：之前的 cors-proxy 进程仍在运行。

**解决**：

```bash
lsof -ti:5177 | xargs kill
```

---

### 旧页面重复注入失败

**现象**：在某个页面多次点击书签后，面板不再出现或功能异常，但在新页面可以正常注入。

**原因**：上一次注入留下的 `window.__hermes` 实例处于损坏状态，`unmount()` 抛出异常中断了新实例的挂载流程；或旧的 `#__hermes-root` 容器残留在 DOM 中。

**解决**：`demo.ts` 已做两层防护：

1. `unmount()` 用 try-catch 包裹，失败时强制置 `undefined` 继续挂载。
2. 挂载前主动移除页面上残留的 `#__hermes-root` 元素。

若问题仍存在，可在 DevTools Console 手动清理后重试：

```javascript
document.getElementById('__hermes-root')?.remove()
window.__hermes = undefined
```
