# 录制与回放功能设计文档

**日期：** 2026-04-16  
**状态：** 已确认，待实现

---

## 背景

Page Agent 目前只能由 LLM 驱动页面操作。本功能在此基础上增加"录制用户操作 → 持久化 → 回放"能力，使开发者可生成自动化脚本，普通用户也可通过 UI 一键录制和重播操作流程。

---

## 目标

- 录制用户在页面上的 click / input / select / scroll 操作，支持 SPA 路由切换
- 将录制结果持久化到 IndexedDB，跨页面刷新保留
- 回放时精确或模糊定位元素，失败时停止并上报
- 在现有 Panel UI 中新增"录制"标签页，供终端用户操作
- 同时提供 `@page-agent/recorder` 包的 API，供开发者直接调用

---

## 范围限制

- 不支持跨真实页面刷新的录制（仅支持 SPA 前端路由切换）
- 不支持 Chrome Extension 跨 tab 录制
- 不引入第三方库，IndexedDB 使用原生 API

---

## 方案选择

采用**方案 A**：新建 `packages/recorder` 独立包，遵循现有 monorepo 架构风格，`PageController` 最小改动，UI 改动集中在 `packages/ui`。

---

## 数据结构

```ts
// packages/recorder/src/types.ts

type ActionRecord =
  | { type: 'click';    xpath: string; elementDesc: string }
  | { type: 'input';    xpath: string; elementDesc: string; text: string }
  | { type: 'select';   xpath: string; elementDesc: string; option: string }
  | { type: 'scroll';   down: boolean; pixels: number; xpath?: string }
  | { type: 'navigate'; url: string }

interface Recording {
  id: string        // uuid
  name: string      // 默认取录制时的 document.title
  url: string       // 录制起始页 URL
  createdAt: number // Date.now()
  actions: ActionRecord[]
}
```

**说明：**
- `xpath` 是跨 DOM 刷新的稳定标识，不存临时 index
- `elementDesc` = `tagName + text + aria-label`，用于 UI 展示和模糊匹配降级
- `navigate` 记录用于回放时等待新路由渲染完成

---

## 包结构

```
packages/recorder/
├── src/
│   ├── types.ts           # ActionRecord, Recording 类型定义
│   ├── Recorder.ts        # 监听用户事件，生成 ActionRecord
│   ├── Replayer.ts        # 读取 ActionRecord，调用 PageController 执行回放
│   ├── RecordingStore.ts  # IndexedDB CRUD
│   └── index.ts           # 统一导出
├── package.json
└── tsconfig.json

packages/page-controller/
└── src/PageController.ts  # 新增 getSelectorMap() 公开方法

packages/ui/
└── src/
    └── RecordingPanel/
        ├── index.tsx               # 面板入口，状态机
        ├── RecordingControls.tsx   # 开始/停止按钮 + 状态指示
        ├── RecordingPreview.tsx    # 录制中实时动作列表
        └── RecordingHistory.tsx    # 已保存录制列表 + 回放/删除
```

---

## Recorder 设计

### 启动流程

```
start()
  → controller.updateTree()
  → buildXpathMap()           // selectorMap 反转：element → xpath
  → document.addEventListener('click',  onUserClick,  { capture: true })
  → document.addEventListener('change', onUserChange, { capture: true })
  → document.addEventListener('scroll', onUserScroll, { capture: true, passive: true })
  → 监听 popstate / hashchange / Navigation API navigate
```

### 事件处理（以 click 为例）

```
onUserClick(e)
  → findXpath(e.target)       // 向上找最近的可交互祖先
  → xpath 存在 → push { type: 'click', xpath, elementDesc }
  → controller.updateTree() + buildXpathMap()
```

### SPA 路由处理

- 监听 `popstate` / `hashchange` / Navigation API `navigate`
- 路由变化时不停止录制，插入 `{ type: 'navigate', url }` 记录
- 重新调用 `updateTree()` 重建索引

### stop()

```ts
stop(): Recording
// 返回完整 Recording 对象，不负责持久化
// 调用方自行调用 RecordingStore.save(recording)
```

---

## Replayer 设计

### 回放流程

```
replay(recording)
  → for each ActionRecord:
      controller.updateTree()
      index = findByXpath(action.xpath)      // 精确匹配
      if not found:
          index = fuzzyMatch(action)          // 模糊匹配降级
      if not found:
          emit('step:failed', { action, reason })
          return                              // 停止回放
      executeAction(index, action)
      waitForDomSettle()                      // MutationObserver，300ms 无变化即继续
```

### 元素查找策略

| 级别 | 策略 | 条件 |
|------|------|------|
| 精确匹配 | `node.xpath === action.xpath` | 优先 |
| 模糊匹配 | tagName + 文本 + 关键属性评分 | 精确失败时降级 |

**模糊匹配评分：**
- tagName 相同 → +0.3
- 文本内容相同（normalize 后）→ +0.4
- aria-label / placeholder / role 相同 → 各 +0.1
- 得分 ≥ 0.8 视为匹配，取最高分，匹配不上则停止

### waitForDomSettle

- 使用 `MutationObserver` 监听 DOM 变化
- 连续 300ms 无变化视为稳定
- 最长等待 3s，超时后继续下一步（不报错）

### 事件系统

```ts
replayer.on('step:start',  ({ index, action }) => void)
replayer.on('step:done',   ({ index, action }) => void)
replayer.on('step:failed', ({ action, reason }) => void)
replayer.on('replay:done', () => void)
```

---

## RecordingStore 设计

**IndexedDB 结构：**

```
Database:     page-agent-recordings  (version 1)
Object Store: recordings
  keyPath:    id
  indexes:    createdAt
```

**API：**

```ts
class RecordingStore {
  save(recording: Recording): Promise<void>
  list(): Promise<Recording[]>            // 按 createdAt 倒序
  get(id: string): Promise<Recording | undefined>
  delete(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
}
```

- 单例，懒初始化 DB 连接
- 无第三方依赖，使用原生 IndexedDB API

---

## UI 设计

在现有 Panel 新增第三个标签页"录制"，三个子组件：

```
┌─────────────────────────────┐
│  [AI助手]  [历史]  [录制]   │
├─────────────────────────────┤
│  ● 录制中  00:32            │  RecordingControls
│  [■ 停止录制]               │
├─────────────────────────────┤
│  实时动作预览               │  RecordingPreview（录制中）
│  [0] click  "登录" button   │
│  [1] input  "admin" input   │
├─────────────────────────────┤
│  已保存录制                 │  RecordingHistory
│  登录流程  2026-04-16  ▶ 🗑 │
│  表单填写  2026-04-15  ▶ 🗑 │
└─────────────────────────────┘
```

**面板状态机：**

```
idle → recording → idle（stop 后自动保存到 IndexedDB）
idle → replaying → idle（replay 完成或失败后退出）
recording 和 replaying 互斥
```

回放进行中，每步高亮对应 DOM 元素（复用现有 `highlightIndex` 机制）。

---

## PageController 改动

仅新增一个只读方法：

```ts
// packages/page-controller/src/PageController.ts
getSelectorMap(): ReadonlyMap<number, InteractiveElementDomNode> {
  return this.selectorMap
}
```

---

## 模块依赖关系

```
@page-agent/recorder
  └── @page-agent/page-controller (peer dependency)

@page-agent/ui
  └── @page-agent/recorder
  └── @page-agent/page-controller
```

---

## 不在本次范围内

- 云端同步录制数据
- 录制回放的条件分支（if/loop）
- 截图对比验证
- 跨真实页面刷新的录制保持
- Chrome Extension 跨 tab 录制
