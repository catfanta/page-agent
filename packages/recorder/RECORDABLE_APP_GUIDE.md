# 被录制应用编码准则

本文档面向**希望被 Page Agent Recorder 可靠录制和准确回放**的应用开发者，基于 Recorder/Replayer 的内部机制给出具体编码规范。

---

## 核心机制速览

理解以下机制是遵守准则的前提：

| 机制 | 说明 |
|------|------|
| **元素定位** | 三级降级匹配：`elementText` 精确匹配 → `elementHint`（aria-label/title/placeholder）包含匹配 → 降级使用原始索引（不稳定） |
| **事件模拟** | 回放使用 W3C 规范事件序列（pointerdown → mousedown → click）+ 原生 setter 注入 |
| **重新索引** | 每次操作后延迟 500ms 等待 React 重渲染，再调用 `updateTree()` 重新建立 DOM 索引 |
| **命中测试** | 回放用 `document.elementFromPoint(x, y)` 决定实际事件目标 |
| **录制阶段捕获** | 录制器在**捕获阶段**（`{ capture: true }`）注册监听器，优先于应用代码的冒泡监听器执行 |

---

## 准则 1：使用语义化原生元素

**原因**：PageController 的 DOM 提取引擎依据 `tagName`、`role`、`tabindex` 等属性判断元素是否可交互并建立索引。用 `<div>` 模拟按钮不会被索引，回放时无法找到目标元素。

```html
<!-- 禁止 -->
<div class="btn" onclick="submit()">提交</div>
<span class="link" onclick="navigate()">跳转</span>

<!-- 要求 -->
<button type="button" onclick="submit()">提交</button>
<a href="/next">跳转</a>
<input type="text" />
<select><option value="a">选项 A</option></select>
<textarea></textarea>
```

**可被索引的元素类型：** `button`、`a`（有 href）、`input`、`select`、`textarea`、`[role="button"]`、`[role="link"]`、`[contenteditable]`、`[tabindex]`

---

## 准则 2：为每个交互元素提供唯一可读标识

**原因**：`elementText` 精确匹配失败后，回放器依赖 `elementHint`（来自 `aria-label` / `title` / `placeholder`）做包含匹配。两级均失败则只能使用录制时的原始索引，DOM 结构一旦变化就会操作到错误元素。

```html
<!-- 禁止 -->
<button>确认</button>          <!-- 页面有多个"确认"时无法区分 -->
<input type="text" />          <!-- 无任何标识信息 -->
<button><svg>...</svg></button> <!-- 无文本内容 -->

<!-- 要求 -->
<button aria-label="确认删除用户">确认</button>
<input type="text" placeholder="请输入用户名" aria-label="用户名" />
<button aria-label="关闭对话框"><svg>...</svg></button>
<button title="导出为 CSV">导出</button>
```

**标识优先级（与 `Recorder.getElementHint()` 保持一致）：**

1. `aria-label`（最优，语义最强）
2. `title`
3. `placeholder`（仅输入框）

---

## 准则 3：保持元素文本在操作前后稳定

**原因**：`elementText` 匹配是 normalize 后的字符串精确比较。加载状态导致按钮文字变化时，录制和回放的文字不一致会造成匹配失败。

```tsx
// 禁止
<button>{isLoading ? '处理中...' : '提交'}</button>

// 要求：加载态不改变按钮主文字
<button disabled={isLoading} aria-label="提交表单">
  提交
  {isLoading && <Spinner />}
</button>

// 如必须改变文字，在 aria-label 中保持稳定
<button aria-label="提交表单" disabled={isLoading}>
  {isLoading ? '处理中...' : '提交'}
</button>
```

---

## 准则 4：使用原生表单控件，避免自定义 Select / Input

**原因**：

- `<input>` / `<textarea>` 回放使用 `getNativeValueSetter` 注入原生 setter 后触发 `input` + `change` 事件，稳定可靠。
- `<select>` 回放通过 `optionText` 文字匹配来选中 `<option>`，要求选项有可读文本。
- 纯 `<div>` 模拟的自定义下拉或输入框无法被以上机制驱动。

```tsx
// 禁止：自定义下拉
<div class="custom-select" onClick={toggleDropdown}>
  {selectedLabel}
  {isOpen && options.map(opt =>
    <div onClick={() => select(opt)}>{opt.label}</div>
  )}
</div>

// 要求：原生 select（可用 CSS 定制外观）
<select value={value} onChange={e => setValue(e.target.value)}>
  <option value="a">选项 A</option>
  <option value="b">选项 B</option>
</select>

// 可接受：ARIA 自定义组件，需有 role="listbox"/"option" 且文字与 optionText 匹配
<div role="listbox" aria-label="选择城市">
  <div role="option" aria-selected={city === 'bj'} onClick={() => setCity('bj')}>北京</div>
  <div role="option" aria-selected={city === 'sh'} onClick={() => setCity('sh')}>上海</div>
</div>
```

---

## 准则 5：不要在捕获阶段阻止事件冒泡

**原因**：录制器在**捕获阶段**（`{ capture: true }`）注册监听器。回放器模拟完整 W3C 事件序列（`pointerdown` → `mousedown` → `click` 等）。在捕获阶段调用 `stopPropagation` 或 `stopImmediatePropagation` 会导致录制器永远收不到事件。

```tsx
// 禁止：在捕获阶段阻止事件传播
document.addEventListener('click', e => e.stopPropagation(), true)  // { capture: true }
document.addEventListener('click', e => e.stopImmediatePropagation(), true)

// 禁止：吞掉 change 事件（导致 input 回放失效）
inputRef.current.addEventListener('change', e => {
  e.stopImmediatePropagation()
  // ...
})

// 要求：事件处理只调用 preventDefault，不调用 stopPropagation
function handleClick(e: MouseEvent) {
  e.preventDefault()   // 可以：阻止默认行为
  // e.stopPropagation() // 禁止：除非有明确的业务原因，且在冒泡阶段
  doAction()
}

// 要求：React 中确保 onChange 正常触发
<input onChange={e => setValue(e.target.value)} value={value} />
```

---

## 准则 6：关键元素必须在视口内可见且可命中测试

**原因**：回放器通过 `element.getBoundingClientRect()` 计算元素中心坐标，再用 `document.elementFromPoint(x, y)` 做命中测试确定真实事件目标。透明遮罩层、`pointer-events` 未设置等问题会导致命中测试返回错误元素。

```css
/* 禁止：透明覆盖层遮挡可交互元素且未设置 pointer-events */
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  /* 缺少 pointer-events: none，会拦截所有点击 */
}

/* 要求：遮罩层显式声明 pointer-events */
.modal-backdrop {
  pointer-events: none; /* 允许事件穿透到背后元素 */
}
.modal-content {
  pointer-events: auto; /* 只有内容区接收事件 */
}
```

```tsx
// 禁止：用 opacity:0 隐藏但保留事件区域
<div style={{ opacity: 0 }} onClick={handleClick}>隐藏按钮</div>

// 要求：真正不可见的元素用 display:none 或 visibility:hidden
// 并确保没有元素意外遮挡交互区域
```

---

## 准则 7：异步状态更新在 500ms 内完成

**原因**：录制器在每次用户操作后延迟 500ms 调用 `pageController.updateTree()` 重新索引 DOM。如果 API 请求后的 UI 更新超过 500ms，录制器会基于旧 DOM 建立索引，导致下一步录制的索引指向错误元素。

```tsx
// 问题：慢速 API 导致重渲染超过 500ms
async function handleSave() {
  await slowApiCall()    // 耗时 1000ms+
  setItems(newItems)     // 触发重渲染 —— 此时录制器已完成索引，DOM 还未更新
}

// 要求：使用乐观更新，立即反映 UI 变化
async function handleSave() {
  setItems(optimisticItems)  // 立即更新 UI（在 500ms 内完成）
  try {
    await apiCall()
  } catch {
    setItems(previousItems)  // 失败时回滚
  }
}

// 要求：加载态只追加元素，不改变已有元素的位置和文字
function ItemList() {
  return (
    <ul>
      {items.map(item => <li key={item.id}>{item.name}</li>)}
      {isLoading && <li aria-label="加载更多数据">加载中...</li>}  {/* 追加而非替换 */}
    </ul>
  )
}
```

---

## 准则 8：SPA 路由使用 pushState / replaceState

**原因**：录制器通过 patch `window.history.pushState` 和 `replaceState`，以及监听 `popstate` / `hashchange` 事件捕获导航动作并记录 `navigate` 步骤。直接赋值 `location.href` 会触发整页刷新，导致录制序列在刷新边界处断裂。

```tsx
// 推荐：使用框架路由（内部调用 pushState，会被正确捕获）
import { useNavigate } from 'react-router-dom'
const navigate = useNavigate()
navigate('/settings')

// 可接受：hash 路由（触发 hashchange，被录制器支持）
window.location.hash = '#/settings'

// 禁止：直接赋值 href（整页刷新，录制序列断裂）
window.location.href = '/settings'
```

---

## 准则 9：避免在交互元素内部嵌套其他交互元素

**原因**：命中测试（`elementFromPoint`）返回最顶层元素，点击坐标落在嵌套子元素上时，返回的是子元素而非预期的父元素，导致录制索引与实际操作不一致。

```html
<!-- 禁止：可交互元素嵌套 -->
<button>
  <a href="/detail">查看详情</a>  <!-- 命中测试返回 <a>，不是 <button> -->
</button>

<!-- 禁止：带点击事件的 div 包含 button -->
<div onclick="selectItem()">
  <button onclick="deleteItem()">删除</button>  <!-- 点击删除时同时触发父级 -->
</div>

<!-- 要求：扁平化交互结构 -->
<div class="item-row">
  <span class="item-name">商品名称</span>
  <button aria-label="选择商品" onclick="selectItem()">选择</button>
  <button aria-label="删除商品" onclick="deleteItem()">删除</button>
</div>
```

---

## 准则 10：富文本编辑器优先使用 input / textarea

**原因**：回放器对 `contenteditable` 有两套降级方案（合成 beforeinput 事件 → `execCommand('insertText')`），`execCommand` 在现代浏览器已废弃且行为不一致。原生 `<input>` 和 `<textarea>` 使用原生 setter 注入，稳定可靠。

```tsx
// 普通文本输入一律使用 input
<input
  type="text"
  value={value}
  onChange={e => setValue(e.target.value)}
  aria-label="搜索关键词"
/>

// 多行文本使用 textarea
<textarea
  value={value}
  onChange={e => setValue(e.target.value)}
  aria-label="备注信息"
/>

// 仅在必须支持富文本格式时使用 contenteditable
// 必须监听 input 事件（不只是 keydown），并提供 aria-label
<div
  contentEditable
  onInput={e => setContent(e.currentTarget.textContent)}
  aria-label="富文本编辑区"
/>
```

---

## 快速检查清单

在 PR 合并前，针对新增交互元素逐项检查：

```
□ 使用原生语义标签（button / a / input / select / textarea）
□ 每个元素有唯一的 aria-label 或稳定的可读文字内容
□ 输入框有 placeholder 或 aria-label
□ 没有透明覆盖层遮挡交互元素（检查 z-index 和 pointer-events）
□ 没有在捕获阶段调用 stopPropagation / stopImmediatePropagation
□ UI 变化在用户操作后 500ms 内完成（推荐乐观更新）
□ 没有在可交互元素内嵌套其他可交互元素
□ 路由跳转使用框架路由（pushState），不直接修改 location.href
□ 下拉使用原生 <select>，或提供 role="listbox" / "option" 语义
□ 纯图标按钮有 aria-label（因为 elementText 为空，定位完全依赖 hint）
```

---

## 与 RECORDER.md 的关系

[RECORDER.md](./RECORDER.md) 描述的是 **Recorder/Replayer 库本身**的用法和架构。

本文档描述的是**被录制的目标应用**应如何设计，两者互为补充。
