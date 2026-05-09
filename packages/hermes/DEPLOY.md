# Hermes 部署指南

本文档描述将 HermesPanel 嵌入到其他项目的两种方式。

---

## 方式一：Script 标签嵌入（托管 IIFE）

适用场景：目标页面是任意技术栈（Vue、原生 HTML、Django 模板等），无需修改目标项目的构建流程。

### 原理

`npm run build:demo` 生成一个自包含的 IIFE 脚本（`hermes.demo.js`），将其托管到静态服务器或 CDN，在目标页面加一个 `<script>` 标签即可。脚本加载时自动将 HermesPanel 挂载到 `document.body`。

### 步骤

**1. 构建 IIFE 产物**

```bash
cd packages/hermes

# 可选：在 .env.local 中预设 API key，避免在 URL 中明文传递
echo "VITE_HERMES_API_KEY=your-secret-key" > .env.local

npm run build:demo
# 输出：dist/iife/hermes.demo.js
```

**2. 托管静态文件**

将 `dist/iife/hermes.demo.js` 上传到静态托管服务，例如：

```bash
# 示例：上传到 OSS / S3 / Cloudflare R2
# 结果 URL 类似：https://cdn.example.com/hermes.demo.js
```

本地开发时可直接用 `serve`：

```bash
npx serve dist/iife -p 5176
```

**3. 在目标页面加 Script 标签**

```html
<!-- 生产环境：指向 CDN 地址和实际后端 -->
<script src="https://cdn.example.com/hermes.demo.js?baseURL=https://hermes.example.com"></script>

<!-- 开发环境：本地文件服务 + CORS 代理 -->
<script src="http://localhost:5176/hermes.demo.js?baseURL=http://localhost:5177"></script>
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
window.__hermes.unmount()

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

## 方式三：发布为 React 组件库

适用场景：目标项目是 React 应用，希望将 HermesPanel 作为一个标准的 npm 包引入，像普通组件一样使用。

### 当前限制

`@page-agent/hermes` 目前是 `private: true` 的私有包，没有库导出入口。以下步骤描述如何将其改造为可发布的库。

### 步骤

**1. 新建库导出入口 `src/index.ts`**

```typescript
export { HermesPanel } from './HermesPanel'
export type { } // 如有对外暴露的类型，在此补充
```

**2. 新建库构建配置 `vite.lib.config.js`**

```javascript
// @ts-check
import react from '@vitejs/plugin-react-swc'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import dts from 'unplugin-dts/vite'
import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    plugins: [
        react(),
        // 将 Panel.module.css 等样式打包进 JS，消费方无需单独引入 CSS
        cssInjectedByJsPlugin({ relativeCSSInjection: true }),
        // 生成 .d.ts 类型声明
        dts({ bundleTypes: true }),
    ],
    publicDir: false,
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            fileName: 'hermes',
            formats: ['es'],
        },
        outDir: resolve(__dirname, 'dist', 'esm'),
        rollupOptions: {
            // React 和 React DOM 不打包进去，由消费方提供
            external: ['react', 'react-dom', 'react/jsx-runtime'],
        },
        minify: false,
        sourcemap: true,
    },
    define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.VITE_HERMES_API_KEY': JSON.stringify(''),
    },
})
```

**3. 更新 `package.json`**

```json
{
    "name": "@page-agent/hermes",
    "private": false,
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
        "main": "./dist/esm/hermes.js",
        "types": "./dist/esm/hermes.d.ts",
        "exports": {
            ".": {
                "types": "./dist/esm/hermes.d.ts",
                "import": "./dist/esm/hermes.js",
                "default": "./dist/esm/hermes.js"
            }
        }
    },
    "peerDependencies": {
        "react": ">=18.0.0",
        "react-dom": ">=18.0.0"
    },
    "scripts": {
        "build:lib": "vite build --config vite.lib.config.js",
        "prepublishOnly": "node ../../scripts/pre-publish.js && npm run build:lib"
    }
}
```

> `main` / `exports` 指向 `src/`（开发时 monorepo 直接引 TypeScript 源码）；`publishConfig` 在发布时被 `pre-publish.js` 提升为顶级字段，指向构建产物。

**4. 构建并发布**

```bash
cd packages/hermes

# 构建库产物（输出到 dist/esm/）
npm run build:lib

# 发布到 npm（pre-publish 脚本会自动执行）
npm publish
```

**5. 消费方使用**

安装：

```bash
npm install @page-agent/hermes react react-dom
```

在 React 应用中引入：

```tsx
import { HermesPanel } from '@page-agent/hermes'

export function App() {
    return (
        <div>
            {/* 你的页面内容 */}
            <HermesPanel
                baseURL="https://hermes.example.com"
                apiKey="your-key"
            />
        </div>
    )
}
```

`HermesPanel` 接受以下 props：

| Prop | 类型 | 说明 |
|------|------|------|
| `baseURL` | `string?` | Hermes 后端地址，不传则以相对路径 `/api/hermes/v1/chat/completions` 发请求 |
| `apiKey` | `string?` | Bearer token |
| `onClose` | `() => void?` | 用户点击关闭按钮时的回调 |

**6. 同 monorepo 内直接引用（无需发布）**

如果消费方也在这个 monorepo 里，无需发布，直接在 `package.json` 中声明依赖即可：

```json
{
    "dependencies": {
        "@page-agent/hermes": "*"
    }
}
```

然后正常 import：

```tsx
import { HermesPanel } from '@page-agent/hermes'
```

monorepo 的 source-first 机制会自动解析到 `src/index.ts`。

### 样式说明

库构建启用了 `cssInjectedByJsPlugin`，所有样式（包括 `Panel.module.css`）会被打包进 `hermes.js`。消费方**不需要**单独引入任何 CSS 文件，`import { HermesPanel } from '@page-agent/hermes'` 即可获得完整样式。

---

## 方式对比

| | 方式一（Script 标签） | 方式三（组件库） |
|---|---|---|
| 目标技术栈 | 任意 | React |
| 集成难度 | 低（一行 script） | 中（npm install + import） |
| 类型支持 | 无 | 完整 TypeScript 类型 |
| 样式隔离 | 注入全局 DOM | 同上（CSS-in-JS） |
| 版本管理 | 通过 URL 版本号 | npm 语义版本 |
| 适合场景 | 已有项目快速接入 | 新项目深度集成 |
