# React / 前端 UI 黑盒验收（L0 / L1）

本文件只讲**怎么打开看一眼**。对应 `dev-test-strategy` 的 L0 / L1；
逻辑分支、数据边界、长期回归仍走 L2（见 `react.md` §5）。

## 1. 起服务

- `pnpm dev`（Vite 默认 5173，Next 默认 3000）；容器里跑要加 `--host 0.0.0.0`，否则只有容器内可达。
- 用 `tool-jobs` 后台跑，别前台阻塞；等到 `curl -sI http://127.0.0.1:<port>` 返回 200、或页面 body 非空再截图。
- 端口被占先 `lsof -i :<port>` 查占用，不要靠猜端口。

## 2. 切视口

用 `browser_viewport`（`dsh-browser-native`）：

| 档 | width × height | DPR | mobile | touch |
|---|---|---|---|---|
| desktop | 1440 × 900 | 1 | false | false |
| tablet | 1024 × 768 | 2 | false | false |
| mobile | 390 × 844 | 3 | true | true |

抽样规则：普通卡默认 **desktop + 一个移动档**；只有「响应式专项卡」才跑三档。
跑完调 `browser_viewport({ reset: true })` 复位，别把视口状态带到下一张图。

## 3. 截图

1. `browser_navigate` 打开目标路由（SPA 用 hash/route 直达，别靠点菜单绕）。
2. `browser_screenshot` 落盘；文件放 **`.shots/`**，该目录必须已在 `.gitignore` 里，不入库。
3. 每张图用 `read_image` **真的看一眼**；只把路径写进报告不算验收。
4. 命名 `<screen>__<viewport>__<state>.png`，报告里引用相对路径。

## 4. 判断口径（看到什么算不对）

按优先级：

1. 布局塌陷、横向滚动条（`document.scrollingElement.scrollWidth > clientWidth`）；
2. 断点错位：移动档出现宽表格、按钮不可点、文字截断；
3. 状态缺失：空 / 错 / 加载态看不到；
4. token 违规：硬编码颜色、间距与设计不符（交 `dev-ui-review` 判级）；
5. 文案、路由、返回行为与卡片写的行为清单不一致。

## 5. 何时升级到 L2

只有三种情况，写清是哪一类并在 `tests/` **只写一次**：

- **回归保护**：这条路径以后会被反复改；
- **逻辑分支**：同一交互按数据分叉，肉眼不好证明；
- **数据边界**：空 / 超长 / 并发 / 失败重试。

没有理由就不要升 L2。

## 6. 禁止

- 禁止在仓库里写一次性截图/断言脚本（`board-shots.mjs`、`ui-verify.mjs` 之类）；
- 禁止提交 `.shots/`；
- 禁止只贴截图路径、不看图就下结论；
- 禁止用组件测试替代"打开看一眼"。

## 7. 已知限制

- **工具面没有 `browser_viewport` 时**（0.8.x 及更早）：先做桌面单视口 + 手工截图，报告里标注限制；不要为此写脚本。
- **登录墙**：用仓库已有的 dev 登录态或 seed 用户；不要为截图在仓库里加绕过代码。
- **SSR / 非 SPA**：先确认首屏渲染完成（`networkidle` 或等关键元素出现）再截。
- **需要真实数据**：用仓库自带 seed / mock；现造数据层属于越界。
