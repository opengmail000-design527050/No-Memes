# 暗色模式实施计划（交给执行者的完整说明）

> 本文件是完整交接文档，执行者无需其他上下文。做完后本文件可删除。
> 项目：纯静态站（index.html + style.css + app.js），无构建步骤，改完即生效。
> 现有风格：手绘水彩绘本风（奶油纸底、歪框、手写字体），暗色模式必须保持这个气质：
> **不走纯黑+荧光，走「夜晚的深色牛皮纸」——深暖褐底、米白墨线、低饱和水彩**。

## 总体机制

- 用 `html[data-theme="light"|"dark"]` 属性驱动，**不用** `@media (prefers-color-scheme)` 包裹暗色样式（因为有手动开关）。
- 首次访问无 localStorage 记录 → 读 `matchMedia('(prefers-color-scheme: dark)')` 决定初始值。
- 点右上角开关 → 翻转 `data-theme` + 写 `localStorage.theme` + 同步更新 `<meta name="theme-color">` 的 content。

---

## 1. style.css

### 1a. 暗色变量覆盖（文件末尾追加）

```css
html[data-theme="dark"] { ... }
```

覆盖 `:root`（style.css 第 5–26 行）里的变量，调色方向：

| 变量 | 亮色现值 | 暗色方向 |
|---|---|---|
| `--paper` | #f8efdc | 深暖褐纸，约 #2b2620 一档 |
| `--card` | #fdf8ea | 比 paper 稍浅一档，如 #352f27 |
| `--ink` | #3a3226 | 米白，如 #e8e0d0 |
| `--ink-soft` | #6e644f | 灰米，如 #a89a80 |
| `--line` / `--line-soft` | rgba(58,50,38,…) | 换成米白基的 rgba，保持 .8/.45 两档透明度 |
| `--gold` | #e2b64c | 略提亮降饱和 |
| `--accent` | #cc6e64 | #e08a6b 的深一档（hover 用） |
| `--accent-soft` | #e28378 | **#e08a6b**（桌面版暗色定稿同款陶土橙） |
| `--heal` | #4e7a3d | 提亮 |
| `--week-fill` / `--week-fill-hover` / `--week-ink` | 紫色系 | 提亮降饱和，暗底上可读 |
| `--ink-dash` | data-URL SVG | **描边色 `%236e644f` 写死在 URL 里**，需在暗色块里重新声明一份整条 data-URL，描边换浅色（如 %23a89a80） |

### 1b. 暗色块里重新声明的写死颜色规则（纯追加覆盖，不改亮色部分）

- `body` 背景四层（第 44–48 行）：两角云朵 rgba(185,202,214,…) 换夜色蓝灰、中央暖光 #fdf6e4 换深暖色、底色 var(--paper) 自动生效。
- `.sugg .item:hover` 的 `#f4ead2`（第 166 行）→ 深一档卡片色。
- `.charHead .clearBadge` 的 `#337a55`（第 238 行）、`.card .status.clear` 的 `#337a55`（第 289 行）、`.card .status.prog` 的 `#a2553f`（第 290 行）→ 暗底上提亮（绿约 #7fc99a 系、陶土约 #d99277 系，与笔刷垫底协调即可）。
- `dialog input` 的 `background: #fff`（第 683 行附近）→ 深色输入框底。
- `dialog .note code` 的 `#f1e6cb`（第 664 行）→ 深色。
- `.weekPaint .wash2` 的 rgba(160,138,200,.3) 与 hover .42（第 380、393 行）→ 提亮。
- `.weekBase path`、`.wipeStrip .segInk`、`.segLead` 的 rgba(58,50,38,…) 描边（第 468、525、538 行）→ 米白基 rgba。
- `::selection`（第 30 行）→ 用暗色 accent 的低透明度。
- `dialog::backdrop`（第 661 行）→ 更深的遮罩，如 rgba(0,0,0,.5)。
- `.member.tank/.heal/.dps` 的 `--wash`（第 572–574 行）→ 三色各提亮一点。
- **重点坑**：`.member img` 的 `mix-blend-mode: multiply`（第 580 行）在暗底会把职业图标压成黑块。暗色下改 `mix-blend-mode: normal`（filter 微调即可）。
- 各处 `box-shadow: rgba(58,50,38,…)` 手绘投影**不用动**——深影落在深底上近乎不可见，无害。

### 1c. 主题切换按钮样式（约 25 行）

```css
.themeToggle { ... }
```

- 复用 `.ghost` 底子（HTML 上同时挂 ghost 和 themeToggle 两个 class），但**偏长方形**：border-radius 用小幅 wobble，如 `12px 16px 13px 17px / 16px 12px 17px 13px`（参考 dialog input 的歪法），不要用大歪度的 `--wobble-a/b`。
- 内部两个词 `<span class="tw light">Light</span>` 和 `<span class="tw dark">Dark</span>`，中间 `<span class="sep">/</span>`：
  - 容器 `display: inline-flex; align-items: baseline; gap: 4px;`（基线对齐，大小字不跳）。
  - **当前模式的词**：`font-size: 16px; font-weight: 700; color: var(--accent-soft);`（亮色下即 #E28378，暗色下自动变 #e08a6b——这是已确认的决定，不要写死色值）。
  - **另一个词**：`font-size: 12px; color: var(--ink-soft);`
  - 激活态由属性选择器驱动，不用 JS 改样式：
    ```css
    html[data-theme="light"] .themeToggle .tw.light { /* 大+橙 */ }
    html[data-theme="dark"]  .themeToggle .tw.dark  { /* 大+橙 */ }
    ```
  - `.tw { transition: font-size .18s ease, color .18s ease; }` 切换时此消彼长。
- `.sep`：`font-size: 12px; color: var(--ink-soft);`
- 560px 断点（第 710 行的 media query）里检查 header 两个按钮并排放得下，必要时缩 padding/字号。

## 2. index.html

- header 里「登录 FF Logs」按钮旁（第 24 行）加：
  ```html
  <button id="themeToggle" class="ghost themeToggle" title="切换外观"><span class="tw light">Light</span><span class="sep">/</span><span class="tw dark">Dark</span></button>
  ```
- 为避免首帧闪白：在 `<head>` 里、style.css 之前加一小段内联 script，读 localStorage/matchMedia 后立刻设 `document.documentElement.dataset.theme`（3 行以内）。

## 3. app.js

### 3a. 主题开关逻辑（文件末尾，约 10 行）

- 初始 data-theme 已由 head 内联脚本设好；这里只绑 `#themeToggle` 的 click：翻转 `data-theme`、写 `localStorage.theme`、更新 theme-color meta 的 content（亮 #f8efdc / 暗用 --paper 的暗色值）。

### 3b. 三处写死颜色改用 CSS 变量（JS 生成的内联 SVG，fill 属性支持 var()）

- `brushStroke()` 第 682–687 行：绿笔刷 `88,214,141` 与橙笔刷 `222,140,110` 两组 rgba → 改成 `fill: var(--brush-xxx-1)` / `var(--brush-xxx-2)`（每种笔刷两层、透明度 .30/.28 不同，所以每色定义两个变量，rgba 整体放进 CSS 变量里）。调用处（第 659、701 行）传变量名而非 RGB 字符串。
- 第 838 行紫色 `rgba(126,101,166, alpha)`：alpha 是逐段计算的动态值，改法：fill 用 `rgba(var(--wipe-rgb), ${alpha})` **不行**（SVG 属性里不支持这种嵌套），改成 fill 设纯色变量 + `fill-opacity=${alpha}` 属性。
- 上述新变量在 style.css 的 `:root` 定义亮色值（保持现渲染完全一致），暗色块里给提亮版。

## 4. 不要动的

`manifest.webmanifest`、fonts/、icons/、favicon、部署流程。

## 5. 验收

1. 本地起个静态服务器（如 `python3 -m http.server`）打开。
2. 亮色下渲染与改动前**完全一致**（笔刷、周条、团灭分布颜色逐个对比）。
3. 点开关：整站切暗色，按钮上 Dark 变大变橙、Light 缩小;再点切回。
4. 刷新页面：主题保持（localStorage 生效），且无首帧闪白。
5. 暗色下重点检查：职业图标不是黑块（multiply 坑）、断续墨线可见（--ink-dash）、周条 tooltip、设置 dialog、搜索建议 hover。
6. 无痕窗口首次访问：跟随系统外观。
