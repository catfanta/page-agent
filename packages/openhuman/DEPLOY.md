# OpenHuman 部署指南

本文档描述将 OpenHumanPanel 嵌入到其他项目的方式。

---

## 方式一：Script 标签嵌入（托管 IIFE）

适用场景：目标页面是任意技术栈（Vue、原生 HTML、Django 模板等），无需修改目标项目的构建流程。

### 原理

`npm run build:demo` 生成一个自包含的 IIFE 脚本（`openhuman.demo.js`），将其托管到静态服务器或 CDN，在目标页面加一个 `<script>` 标签即可。脚本加载时自动将 OpenHumanPanel 挂载到 `document.body`。

### 步骤

**1. 构建 IIFE 产物**

```bash
cd packages/openhuman

# 可选：在 .env.local 中预设 API key，避免在 URL 中明文传递
echo "VITE_HERMES_API_KEY=your-secret-key" > .env.local

npm run build:demo
# 输出：dist/iife/openhuman.demo.js
```

**2. 托管静态文件**

将 `dist/iife/openhuman.demo.js` 上传到静态托管服务，例如：

```bash
# 示例：上传到 OSS / S3 / Cloudflare R2
# 结果 URL 类似：https://cdn.example.com/openhuman.demo.js
```

本地开发时可直接用 `serve`：

```bash
npx serve dist/iife -p 5176
```

**3. 在目标页面加 Script 标签**

```html
<!-- 生产环境：指向 CDN 地址和实际后端 -->
<script src="https://cdn.example.com/openhuman.demo.js?baseURL=https://hermes.example.com"></script>

<!-- 开发环境：本地文件服务 + CORS 代理 -->
<script src="http://localhost:5176/openhuman.demo.js?baseURL=http://localhost:5177"></script>
```

脚本支持以下 URL 参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `baseURL` | Hermes 后端地址（不含路径） | 空（同源相对请求） |
| `apiKey` | Bearer token，明文写在 URL 中有泄漏风险，建议构建时内联 | 构建时内联的 `VITE_HERMES_API_KEY` |

**4. 控制面板生命周期**

脚本加载后挂载的面板可通过全局变量控制：

```javascript
// 卸载面板
window.__openhuman.unmount()

// 重新加载脚本即重新挂载（自动清理旧实例）
```

### CORS 注意事项

目标页面与 Hermes 后端不同源时，后端需要允许跨域，或在中间加 CORS 代理。

**方案 A：后端配置 CORS 响应头**（推荐生产环境）

在 Hermes 后端添加：

```
Access-Control-Allow-Origin: https://your-app.example.com
Access-Control-Allow-Headers: Content-Type, Authorization, X-Hermes-Session-Key
Access-Control-Allow-Methods: POST, OPTIONS
```

**方案 B：反向代理**（推荐生产环境）

用 Nginx 或 Cloudflare Worker 在同一域名下代理 Hermes 后端，消除跨域问题：

```nginx
location /hermes/ {
    proxy_pass http://hermes-backend:8642/;
    proxy_set_header Host $host;
}
```

然后 `baseURL` 填 `/hermes`（同源），无需额外 CORS 配置。

**方案 C：本地 CORS 代理**（仅开发）

`npm run dev:demo` 已自动启动 CORS 代理（端口 5177），开发时使用 `baseURL=http://localhost:5177`。

### 安全提醒

- `VITE_HERMES_API_KEY` 会被内联到 JS 产物中，随页面源码可见。生产环境建议后端通过 Cookie / Session 鉴权，不依赖 Bearer token。
- `apiKey` URL 参数会出现在请求日志和浏览器历史中，避免在生产环境使用。

---

## 方式三：作为 React 组件库引入

适用场景：目标项目是 React 应用，将 OpenHumanPanel 作为标准 npm 包或本地包引入，像普通组件一样使用。

### 步骤

**1. 构建库产物**

```bash
cd packages/openhuman
npm run build:lib
# 输出：dist/lib/openhuman.js 和 dist/lib/openhuman.d.ts
```

**2. 选择引入方式**

根据场景选择以下三种方式之一：

---

**方案 A：发布到 npm 后安装**

```bash
# 在 packages/openhuman 下执行
# prepublishOnly 会自动将 package.json 中的 exports 从 src/ 切换到 dist/lib/，再执行构建
npm publish
```

消费方安装：

```bash
npm install @page-agent/openhuman
```

---

**方案 B：本地包安装（不发布 npm）**

适合在真实项目中测试本地修改，或在无法访问 npm 的环境中分发。

```bash
# 在 packages/openhuman 下执行
# prepack 钩子会自动完成：manifest 重写（exports 切换到 dist/）+ lib 构建
npm pack
# 输出：page-agent-openhuman-1.8.0.tgz（文件名随版本号变化）
```

> **注意**：`prepack` 会将内部依赖（`@page-agent/*`）从 tarball 的 `dependencies` 中移除，
> 因为它们已被打包进 `dist/lib/openhuman.js`，消费方无需单独安装。

在消费方项目中安装：

```bash
npm install /path/to/page-agent-openhuman-1.8.0.tgz
```

---

**方案 C：同 monorepo 内直接引用**

消费方也在本 monorepo 中时，无需构建和发布，在消费方的 `package.json` 中声明依赖：

```json
{
    "dependencies": {
        "@page-agent/openhuman": "*"
    }
}
```

monorepo 的 source-first 机制会直接解析到 `src/index.ts`，无需任何额外步骤。

---

**3. 在 React 应用中使用**

```tsx
import { OpenHumanPanel } from '@page-agent/openhuman'

export function App() {
    return (
        <div>
            {/* 你的页面内容 */}
            <OpenHumanPanel
                baseURL="https://hermes.example.com"
                apiKey="your-key"
            />
        </div>
    )
}
```

`OpenHumanPanel` 接受以下 props：

| Prop | 类型 | 说明 |
|------|------|------|
| `baseURL` | `string?` | Hermes 后端地址，不传则以相对路径 `/api/hermes/v1/chat/completions` 发请求 |
| `apiKey` | `string?` | Bearer token |
| `onClose` | `() => void?` | 用户点击关闭按钮时的回调 |
| `recording` | `{ recorder, replayer }?` | 外部注入的录制依赖；不传时组件自动创建 PageController + Recorder + Replayer |

### 样式说明

库构建启用了 `cssInjectedByJsPlugin`，所有样式会被打包进 `openhuman.js`。消费方**不需要**单独引入任何 CSS 文件。

---

## 方式对比

| | 方式一（Script 标签） | 方式三 A（npm 发布） | 方式三 B（本地包） | 方式三 C（monorepo） |
|---|---|---|---|---|
| 目标技术栈 | 任意 | React | React | React（同 monorepo） |
| 集成难度 | 低（一行 script） | 低（npm install） | 中（pack + install） | 低（声明依赖即可） |
| 类型支持 | 无 | 完整 TypeScript 类型 | 完整 TypeScript 类型 | 完整 TypeScript 类型 |
| 样式隔离 | 注入全局 DOM | CSS-in-JS（打包进 JS） | CSS-in-JS（打包进 JS） | CSS-in-JS（打包进 JS） |
| 版本管理 | 通过 URL 版本号 | npm 语义版本 | 手动分发 .tgz | 源码直接引用 |
| 适合场景 | 任意技术栈快速接入 | 正式发布给外部消费方 | 本地验证 / 无 npm 环境 | monorepo 内部集成 |
