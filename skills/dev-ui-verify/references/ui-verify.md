# UI 黑盒验证参考（L0 / L1）

配套 `SKILL.md`。这里只放参数、就绪判断与失败处置，不含脚本。

## 1. 三档参数

| 档 | width | height | deviceScaleFactor | mobile | touch |
|---|---|---|---|---|---|
| desktop | 1440 | 900 | 1 | false | false |
| tablet | 1024 | 768 | 2 | false | false |
| mobile | 390 | 844 | 3 | true | true（默认跟随） |

调用示例（工具参数）：

```text
browser_viewport({ width: 1440, height: 900 })
browser_viewport({ width: 1024, height: 768, deviceScaleFactor: 2 })
browser_viewport({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
browser_viewport({ reset: true })
```

返回 `{ applied, reset, width, height, deviceScaleFactor, mobile, touch }`；
`reset: true` 时 `applied=false`、尺寸为 0，表示覆盖已清除。

## 2. 端口与就绪

| 栈 | 默认端口 | 启动命令（容器内） |
|---|---|---|
| Vite | 5173 | `pnpm dev --host 0.0.0.0` |
| Next | 3000 | `pnpm dev -H 0.0.0.0` |
| CRA | 3000 | `HOST=0.0.0.0 pnpm start` |

就绪判断（任一条成立即可截图）：

- `curl -sI http://127.0.0.1:<port>` → 200 / 304；
- `curl -s http://127.0.0.1:<port> | head -c 200` 有内容；
- 服务日志出现 `ready in` / `Local:`。

**不要**用固定 `sleep` 等编译完成。

## 3. 常见失败

| 现象 | 先查什么 |
|---|---|
| 截图全白 | 端口没起 / 路由 404 / 前端报错（看服务日志与浏览器 console） |
| 移动档变成 980 宽 | 页面缺 `<meta name="viewport">`，不是工具问题 |
| 点不到元素 | 被遮罩挡住 / `pointer-events:none` / 断点下被隐藏 |
| 样式没生效 | dev server 缓存或 HMR 失败，重启服务再看 |
| 登录墙拦截 | 用 seed 账号或已有登录态，别在仓库加绕过代码 |

## 4. known-limits

- **无 `browser_viewport`**（0.8.x 及更早）：只做桌面单视口 + 手工截图，报告标注。
- **一页一进程**：同一时间只能验证一个页面；多页要串行。
- **SSR / 首屏慢**：等 `networkidle` 或关键元素，不要截到骨架屏就当结论。
- **需要真实数据的复杂交互**：用仓库 seed / mock；造数据层属于越界。
- **对比度 / token 合规**：肉眼只能初判，定级交 `dev-ui-review`。
