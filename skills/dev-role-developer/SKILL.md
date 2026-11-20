---
name: dev-role-developer
description: Developer 子 agent 的执行细则：按栈命令、ref 路由、自检维度、禁止项与交付证据格式。
whenToUse: 需要查 Developer 的按栈命令、自检维度、禁止项与交付细则时使用。
---

# Developer 角色细则

执行流程由 `dev-developer` preset 的 persona 承载（对齐 → 核对项目分支 → 环境 → 编码 → 自测 → 交付）。
本文件只提供**命令、判据与红线**，不重复流程。遇到流程与细则冲突，以 persona 的流程为准。

## 触发条件

- 以 Developer 身份接到 Leader 派发的编码任务；
- 需要查按栈命令、自检维度、交付证据格式或禁止项。

## 角色边界

- 做：执行单个编码任务、按栈搭环境、写实现与测试、自测、提交并给出证据；
- 不做：拆解需求、改验收标准、派发子 agent、宣布「验收通过」；
- 卡片信息不足时停下来问 Leader，不用默认值补齐路径 / 接口 / 版本。

## ref 路由（硬要求）

1. `read` `dev-test-strategy`，按检测表判断技术栈；
2. 打开对应的 `references/<stack>.md`，后续命令与断言**从 ref 复制**，不凭记忆写；
3. 第一条回报输出：`STACK=<栈> REF=<references/xxx.md> DETECT=<命中的检测信号>`。

只加载 `dev-test-strategy` 而没读 ref、没抄命令 = 路由未完成，Leader / Tester 会直接打回。
运行时没有 `skill` 工具时，改为用 `read` 读取包内 `skills/<name>/SKILL.md`（安装后位于
`node_modules/dsh-agent-dev/skills/<name>/SKILL.md`，与 `dist-server/` 同级），并在回报首行声明
`SKILL_TOOL=absent`。

## 按栈命令

### Node / TypeScript

```bash
ls pnpm-lock.yaml package-lock.json yarn.lock 2>/dev/null
node -e "console.log(require('./package.json').packageManager)"
node --version && cat .nvmrc 2>/dev/null
pnpm install --frozen-lockfile      # 有 pnpm-lock.yaml；只有 package-lock.json 时用 npm ci
pnpm run typecheck                  # 无脚本时 pnpm exec tsc --noEmit
pnpm test                           # 或 pnpm exec vitest run
pnpm run build                      # 无脚本时 pnpm exec tsc -p tsconfig.json
pnpm exec vitest run tests/<file>.spec.ts        # 单文件
pnpm exec vitest run -t "<用例名>"                # 单用例
```

### Go

```bash
go mod download
gofmt -l . && go vet ./...
go build ./...
go test ./... -race
```

### Python

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy .
uv run pytest -q
```

### 鸿蒙 ArkTS

```bash
ohpm install
./hvigorw clean
./hvigorw assembleHap --mode module -p product=default
```

## 前端 / UI 改动的默认做法（L0 / L1）

前端不是「补单测证明」，是「跑起来看一眼」。默认顺序：

1. 起 dev server（后台 job），等到端口就绪；
2. `browser_viewport` 切视口（desktop 1440×900 / mobile 390×844，响应式专项卡才跑三档）；
3. `browser_navigate` + `browser_screenshot` 落到 `.shots/`，`read_image` 真的看图；
4. 偏差记 `file:line` 或截图路径 + 期望值；
5. 收尾 `browser_viewport({ reset: true })`。

升级 L2（写断言）只在卡片写明理由时做：回归保护 / 逻辑边界 / 数据边界；断言进 `tests/` 只写一次。
「跑起来看一眼」优先于「写测试证明」——组件测试回答不了「这屏对不对」。

## 自检维度

| 维度 | 检查项 | 不通过的样子 |
|------|--------|--------------|
| 内容 | 功能准确完整，边界与错误路径覆盖，无遗漏 / 冗余 | AC 有断言没实现，或实现了 AC 之外的东西 |
| 格式 | typecheck / lint / build 全 0 错误，风格与仓库一致 | 有 `error TS`、有未格式化文件、构建产物未忽略 |
| 逻辑 | 分支自洽，错误路径有处理，无隐藏耦合 | 只测正向路径；异常输入静默失败 |

每条命令都要记录**退出码 + 关键输出行**（例如 `Tests 12 passed / 0 failed`，以仓库实际输出为准）。任一红 → 回到编码，不进入交付。

## 交付证据格式

```text
项目分支：<branch>
commit：<hash>（本任务范围 <基线>..<commit>）
STACK=… REF=… DETECT=…
命令与退出码：<cmd> → 0（<关键输出行>）
逐条 AC：AC1 pass / AC2 pass …
未覆盖项：<...>
残余风险：<...>
```

`delivery_mode=workspace` 时省略 commit，改为附 `git status --short` + `git diff` 原文，
并写明「未提交 + 原因」，不得把未提交说成已提交。

## 质量红线

- 不交付未自测的代码；
- 不交付未对齐验收标准的代码；
- 同类低级错误不重复出现（第二次出现要写进复盘）；
- 不达标就继续迭代，不用「差不多」收尾；
- 不修改验收标准来让结果变绿。

## 禁止项

- 禁止在主仓库或其他项目的 worktree 里改代码；
- 禁止为本任务新建分支 / worktree / PR，一律沿用卡片给的项目分支；
- 禁止顺手重构、顺手升级依赖、顺手改格式；
- 禁止提交 `dist/`、`node_modules/`、`.env`、日志；
- 禁止 `git add .` 盲加；禁止 `push --force`；
- 禁止把「我跑过了」当成证据，必须贴命令与退出码。
- 禁止为 UI 验证写一次性脚本（截图器、断言器），也禁止把它们放进仓库；缺能力先查工具面（`browser_*`）与 `dev-ui-verify`。
- 禁止用组件测试替代开页面看一眼（UI 重构卡默认不写组件测试）。

## 检查清单

- [ ] 已读本文件与 `dev-test-strategy`，回报含 `STACK=… REF=… DETECT=…` 与复制自 ref 的命令；
- [ ] 已确认 `delivery_mode` 与写权限预检结果（`workspace` 时含 `git diff` 与「未提交 + 原因」）；
- [ ] 沿用项目 worktree 与分支，未新建分支 / worktree；基线 commit 与本任务 diff 范围已记录；
- [ ] 改动范围与卡片一致，无越界文件；
- [ ] typecheck / test / build 全绿，退出码与关键输出已记录；
- [ ] UI 改动已按 L0/L1 取证（三档或抽样视口 + 截图 + 看图），未新增一次性脚本；
- [ ] commit message 合规，必要时已拆 commit；
- [ ] 交付含证据、未覆盖项、残余风险，且未 push。
