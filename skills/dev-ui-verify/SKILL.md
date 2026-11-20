---
name: dev-ui-verify
description: UI 黑盒验证流程（L0/L1）：起 dev server、切三档视口、截图、看图判断，并判定是否升级到 L2。不带脚本，不产生仓库内的验证装置。
whenToUse: 交付或验收 UI 改动（布局、断点、交互、状态）时使用；需要截图证据，或判断"这屏到底对不对"时使用。不用于逻辑断言与数据边界，那属于 L2。
---

# UI 黑盒验证（L0 / L1）

本技能只给流程，**不带脚本**。视口与截图由工具面负责：
`browser_viewport` / `browser_navigate` / `browser_screenshot` / `read_image`。
工具缺失时按末尾「降级」处理，也不要自己写脚本。

## 触发条件

- 手里有 UI 改动：新屏、改布局、改断点、改交互、改状态；
- 卡片的验收是 L0 或 L1（行为清单，而不是断言表）；
- 报告需要补截图证据。

## 步骤

### 1. 起服务

- 用 `tool-jobs` 后台跑 dev server：`pnpm dev --host 0.0.0.0`（Next 用 `pnpm dev -H 0.0.0.0`），
  容器里不加 `--host` 就只有容器内可达。
- 等就绪用证据，不用 sleep：`curl -sI http://127.0.0.1:<port>` 返回 200，或页面 body 非空。
- 端口被占先 `lsof -i :<port>` 查占用。

### 2. 切视口（`browser_viewport`）

| 档 | width × height | DPR | mobile |
|---|---|---|---|
| desktop | 1440 × 900 | 1 | false |
| tablet | 1024 × 768 | 2 | false |
| mobile | 390 × 844 | 3 | true（touch 默认跟随） |

普通卡默认 **desktop + 一个移动档**；只有「响应式专项卡」才跑三档。

### 3. 打开并截图（`browser_navigate` / `browser_screenshot`）

- 走路由直达（hash / path），不要靠点菜单绕进去。
- 截图落 `.shots/`（该目录必须已在 `.gitignore`），命名 `<screen>__<viewport>__<state>.png`。

### 4. 看图判断（`read_image`）

- **必须真的看图**；只把路径写进报告不算验收。
- 偏差写清位置：`file:line` 或截图路径 + 一句「应该是什么 / 现在是什么」。
- 判断口径（按优先级）：布局塌陷与横向滚动条 → 断点错位（宽表格、按钮点不到、文字截断）→
  状态缺失（空/错/加载）→ token 违规（硬编码颜色/间距）→ 文案与路由不一致。

### 5. 定档收尾

- 布局 / 视觉 / 文案 → L0；交互 / 路由 / 状态切换 → L1。
- 命中以下任一 → 升级 L2（并写理由）：回归保护、逻辑分支、数据边界；断言进 `tests/` 只写一次。
- 收尾调 `browser_viewport({ reset: true })`，别把视口状态带进下一个任务。

## 红线

- 禁止写一次性截图 / 断言脚本；禁止把它们复制进仓库（`board-shots.mjs`、`ui-verify.mjs` 这类都不行）。
- 禁止提交 `.shots/`。
- 禁止只贴截图路径、不看图就下结论。
- 缺能力时记 `known-limits`，改工具或降级 —— **不改仓库**。

## 降级（工具或环境不支持时）

- 没有 `browser_viewport`：桌面单视口 + 手工截图，报告标注限制。
- 有登录墙：用仓库已有的 seed 账号或现有 dev 登录态，不为截图在仓库加绕过代码。
- 非 SPA / SSR：等 `networkidle` 或关键元素出现再截。
- 需要真实数据：用仓库自带 seed / mock，不现造数据层。

细节（端口、常见失败、known-limits）见 `references/ui-verify.md`。

## 检查清单

- [ ] 服务就绪有证据（curl 或日志），不是 sleep 猜的；
- [ ] 视口与卡片要求一致（档位、DPR、mobile）；
- [ ] 截图落 `.shots/` 且未入库；
- [ ] 每张图都用 `read_image` 看过；
- [ ] 偏差写了位置与期望；
- [ ] 收尾已 `reset` 视口；
- [ ] 没有新增任何脚本文件。
