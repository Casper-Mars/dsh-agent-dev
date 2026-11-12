<div align="center">

# dsh-agent-dev

**装一个包，得到一支会分工、会验收的开发团队。**

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）的**开发领域原生单包**：<br />
一次安装，得到 Dev Leader 人设 + 13 个领域 Skill + 3 个 agent preset。

[![dsh compatibility](https://github.com/Casper-Mars/dsh-agent-dev/actions/workflows/dsh-compat.yml/badge.svg)](https://github.com/Casper-Mars/dsh-agent-dev/actions/workflows/dsh-compat.yml)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0-4B6EF5)](./package.json)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-3C873A)](./package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

</div>

---

## 这是什么

`dsh-agent-dev` 不是业务应用，也不是又一个工具集——它是**一个开发团队的装配件**。

装上它，你的 dsh 主会话直接变成一个 Dev Leader：拿到「需求 + 验收标准 + 约束」后，
自己编号 AC、拆任务、派 `dev-developer` 编码、再派 `dev-tester` 独立验收；Leader 本人
不写业务代码。

- **零外部核心依赖**：不需要预装任何 agent core，也没有「先编译 core 再装领域包」的前置步骤；
- **零状态**：不写盘、不建资产目录、没有 bootstrap。13 个 Skill 只从包内 `skills/` 读取，升级重装即原样覆盖；
- **只读 Skill**：Skill 正文不会被运行时改写，行为可审计、可 diff；
- **兼容性有闸门**：包自带 `engines.dsh` 声明，dsh 在安装期就会拒绝装到不兼容的运行时上。

## 为什么用它

| 裸 dsh | 装 `dsh-agent-dev` |
|--------|-------------------|
| 你自己想「该怎么让 agent 写代码」 | Leader 人设有完整 6 阶段流程：对齐 → 隔离 → 环境 → 编码 → 自测 → 交付 |
| 编码和验收是同一个人，自己证明自己对 | 编码派 `dev-developer`、验收派 `dev-tester`，**独立副本 + 独立复跑**才算通过 |
| 每次都要口头交代测试怎么跑、worktree 怎么建 | 13 个 Skill 把环境规程、按栈测试命令、worktree/分支规范、缺陷分级全部固化 |
| 子 agent 工具面靠猜，容易给出写权限 | 3 个 preset 预置工具面：Leader 可派发、Developer 可写、Tester 只读兜底 |
| dsh 升级后插件悄悄崩 | 安装期兼容性准入 + 每次合并 main 跑「安装 → 组合 → 冷启动」三层校验 |

## 装上就有

### 13 个领域 Skill

| Skill | 作用 |
|-------|------|
| `dev-environment` | 唯一的环境规程：落 `<workspace>/.agent-env/`、一 repo 一容器、devcontainer 后端、交付前核销、收尾按序回收 |
| `dev-dispatch-contract` | 派发上下文卡片、preset 选择、边界与回报格式 |
| `dev-quality-gate` | 质量闸门（triage 六查）、独立验收分工与缺陷分级 |
| `dev-worktree-git` | worktree / 分支 / commit 规范与写权限预检 |
| `dev-test-strategy` | 只做栈检测与路由，命令在 `references/<stack>.md`（Go / Node-TS / React / Harmony ArkTS / Python） |
| `dev-role-developer` | Developer 的执行细则、自检维度与交付证据 |
| `dev-role-tester` | Tester 的验收细则、边界覆盖与报告格式 |
| `dev-implementation-plan` | 编码前拆小步：文件边界、接口、失败测试优先、每步验证 |
| `dev-code-review` | 提交前自审 / PR 评审：逻辑、边界、测试、安全、分级意见 |
| `dev-systematic-debugging` | 复现、二分缩小、根因分层、先红后绿、回归 |
| `dev-release` | 语义化版本、可重复构建、changelog、灰度回滚 |
| `dev-observability` | 日志 / 指标 / 追踪 / 告警，字段与脱敏、告警可行动 |
| `dev-retro` | 复盘触发条件、失败模式分类与单变量改进提案 |

全部只读：没有 `templates/`、没有 seeds、没有资产落盘步骤。

### 3 个 agent preset

| preset | 用途 | 工具面 |
|--------|------|--------|
| `dev-leader` | 主会话默认 preset / 调度者 | fs / bash / skill / todo / subagent / subagent-control / list-agents |
| `dev-developer` | 编码执行者（写操作必须显式指定） | fs / bash / skill / todo + Developer persona |
| `dev-tester` | 验证执行者 / 子 agent 漏传兜底 | fs / bash / skill / todo + Tester persona |

## 快速开始

前置：dsh `>=0.2.1-rc.2 <0.3.0`、Node ≥ `22.19.0`、pnpm ≥ `11.7.0`。

```bash
# 1) 在仓库根目录装依赖并编译（产出 dist-server/）
pnpm install
pnpm build

# 2) 装进指定 profile（首次使用会自动初始化 profile）
dsh plugin --profile <p> add link:$PWD

# 3) 核对组合树
dsh --profile <p> --dump-config | grep -E "dev-domain|preset-dev-"
```

期望看到：`dev-domain`（`inject: ['skills','agents']`）、`agent-preset-registry.default: dev-leader`、
3 个 `preset-dev-*`，以及顶层与 preset 内两处 `tool-subagent` 覆盖（`agentPreset: dev-tester`、
`allowedAgentPresets: [dev-developer, dev-tester]`、`maxDepth: 1`）。

`link:` 安装的是当前目录，改动后要重新 `pnpm build`——`main` 指向 `dist-server/index.js`，不编译则加载失败。
包本身没有运行时依赖，profile 端无需再补装任何东西。

### 怎么用

装好后主会话就是 Dev Leader。给它「需求 + 验收标准 + 约束」，它会编号 AC、拆任务、派发
`dev-developer` 编码、再派 `dev-tester` 独立验收。Leader 不写业务代码：一律派发子 agent 编码、
一律派发独立 Tester 验收，Leader 只做元操作（读代码 / 写交付说明 / 建 worktree 与分支 / commit 与 push / 环境管理与核销）。

## 版本兼容性

**声明位置**：`package.json` → `engines.dsh`（本版本为 `>=0.2.1-rc.2 <0.3.0`）。

dsh 在安装插件时会读这个字段（存在 `engines.dsh` 时以它为准，忽略 peer 范围）：不满足就直接拒绝
安装并打印不满足项，而不是让你在运行期踩崩溃。所以**升级 dsh 后装不上，先看这个字段**。

**已验证的版本**（三层校验全通过）：

| dsh 版本 | 状态 |
|----------|------|
| `0.2.1-rc.2` | ✅ 基线 |
| `0.2.2-rc.1` | ✅ 当前 npm `latest` |
| `0.2.2-rc.2` | ✅ 当前 npm `next`（CI 的 `next` 通道持续巡检，仅提示不卡 main） |

### 自动校验：每次合并 main 都跑

`.github/workflows/dsh-compat.yml` 在 **push 到 main / PR 到 main / 每天 09:00 / 手动触发**时，
对 npm 上的 `latest`（阻塞）与 `next`（仅提示）分别做三层校验：

1. **安装准入**：把本包按发布形态 `npm pack` 后装进全新 dsh 环境，验证 `engines.dsh` 与 dsh 的判定一致；
2. **patch 组合**：`dsh --profile <p> --dump-config` 能把 `dev-domain` 与 3 个 preset 组进配置树
   （schema 变更会在这里暴露）；
3. **运行时装配**：冷启动 profile，断言 13 个 Skill 真的注册、`skills.get()` 拿得到正文、
   3 个 preset 在 roster 里、主会话默认 preset 是 `dev-leader`（服务契约变更 / 模块解析失败会在这里暴露）。

**不兼容时自动开 issue**（仅定时任务与手动触发）：复用已有 open issue（label `dsh-compat`）而不重复开单，
正文附失败 / 通过版本、声明范围与运行链接；恢复后下一次巡检自动评论并关闭。
push / PR 的失败不开 issue——页面上已经能看到了。

### 本地跑同一条路径

```bash
pnpm compat                 # 校验 npm latest
pnpm compat 0.2.2-rc.2      # 校验指定版本
make compat DSH_VERSION=0.2.2-rc.2   # 等价写法
```

本地能过即 CI 能过——CI 只是把这个脚本放进 matrix 里跑。

### 升级策略

- 上游发布新的 `0.2.x`：先 `pnpm compat <新版本>`，通过则把 `engines.dsh` 的上界保持不变即可（范围已覆盖）；
- 上游发布 `0.3.0`：CI 的 `latest` 通道会变红——这是**信号**，需要按上游 breaking change 改代码，
  再放开上界、补兼容矩阵，而不是直接改范围蒙过去；
- 本包自身发布新版：`make publish` 前会强制跑 `make check`，并拒绝脏工作区与非 main 分支。

## 运行时装配

1. `cordis.patch.yml` 插入 `dev-domain` 插件、`agent-preset-registry`（`default: dev-leader`）与 3 个 preset；
2. 插件 `apply()` 从 `ctx.skills` 注册 13 个 Skill（正文读 `skills/<name>/SKILL.md`），注册中途失败会原子回滚，卸载时按 LIFO 反注册；
3. 插件监听 `agent/created`，只给 **depth 0** 根 agent 注入 `LEADER_PERSONA`；子 agent 使用各自 preset 的 persona，不继承 Leader 人设。

`inject` 只声明 `['skills', 'agents']`；`systemPrompt` 是 per-agent 服务，缺失时只 warn 降级，不阻断 Skill 注册。

两条独立路径，不要混：

- `agent-preset-registry.default: dev-leader` 决定**主会话** preset；
- `tool-subagent.agentPreset: dev-tester` 只决定**子 agent 漏传 `agent_preset`** 时的兜底（出现在 `preset-dev-leader` 内与顶层补丁两处）；
- 写操作必须由 Leader 显式传 `dev-developer`；`allowedAgentPresets` + `maxDepth: 1` 限制可派发目标与递归深度。

## 自检

仓库内六连（全部在仓库根目录执行）：

```bash
pnpm typecheck        # tsc --noEmit
pnpm build            # 产出 dist-server/；npm pack 的内容依赖它
pnpm test             # vitest run：6 个 spec、96 个用例
pnpm verify:install   # 18/18 PASS：13 个 SKILL.md + 5 个 references
pnpm compat           # dsh 兼容性三层校验（默认 npm latest）
npm pack --dry-run    # 发布内容清单（必须在 build 之后执行）
```

判据：

| 命令 | 成功判据 |
|------|----------|
| `pnpm typecheck` | 退出码 0，无类型错误 |
| `pnpm build` | 退出码 0，产出 `dist-server/index.js`、`dist-server/cordis.patch.yml` 与 `dist-server/persona/LEADER.md` |
| `pnpm test` | **96 passed**、退出码 0（测试集为空会直接失败） |
| `pnpm verify:install` | 18 行 `PASS`、退出码 0；任一 `FAIL` 退出码 1；目录 / 参数错误退出码 2 |
| `pnpm compat` | 每个目标输出 `PASS 插件安装准入` / `PASS patch 组合` / `PASS 运行时装配`，退出码 0 |
| `npm pack --dry-run` | build 后共 35 个文件；含 `skills/` 18 个文件、`cordis.patch.yml`、`dist-server/`、`scripts/verify-install.mjs`；不含 `src/`、`tests/`、`node_modules/` |

`verify:install` 默认检查**包内** `skills/`，不需要装进 profile；`--assets <dir>` 只用于手工核查任意目录：

```bash
node scripts/verify-install.mjs --assets /path/to/skills
```

## 发布

发布入口统一收敛在仓库根的 `Makefile`（`make help` 可查全部目标），不要手工拼命令：

| 命令 | 作用 |
|------|------|
| `make check` | 本地验收：build → test → verify → pack |
| `make compat` | dsh 兼容性校验（默认 latest） |
| `make stage-dry` | 演练暂存：`pnpm stage publish --access public --dry-run` |
| `make publish` | 先跑 `check`，全部通过后再 `pnpm stage publish --access public` |

`make publish` 有两道前置保护：工作区必须干净（`git status --porcelain` 非空即拒），必须在 `main`
分支（确需跳过用 `ALLOW_BRANCH=1`）。`pnpm stage` 只是**暂存**，确认后再 `pnpm stage list` →
`pnpm stage approve <stage-id>`（含 2FA）完成发布。

当前**未发布 npm**（`npm view dsh-agent-dev` → 404），在那之前装包只能走本地 `link:`。

## 迁移

### 从 0.1.x（依赖外部 agent core）升级到 0.2.0+

0.1.x 依赖外部 core 与资产目录，0.2.0 起改为原生单包：

1. 移除旧 core：`dsh plugin --profile <p> remove dsh-rsi-agent`；若 `$DSH_HOME/profiles/<p>/package.json`
   的 `dsh.profile.bundles` 仍有该条目，一并删除后 `pnpm install`；
2. 安装新版本：`dsh plugin --profile <p> add link:$PWD`（需先 `pnpm build`）；
3. 按「快速开始」第 3 步核对组合树，再跑 `pnpm verify:install`。

旧资产目录 `<DSH_HOME>/.dsh-rsi-agent/dev/assets` **不迁移、不读取**：存在其中的手工改动一律丢弃，
需要保留请自行备份。

### 回滚到 0.1.0

npm 上没有 0.1.0，回滚只能按本地 tag 进行（`v0.1.0` → `b5d0e06`，未推送）：

```bash
git worktree add /tmp/old v0.1.0
dsh plugin --profile <p> add link:/tmp/old
dsh plugin --profile <p> add dsh-rsi-agent@0.1.x   # 回滚必需：旧 patch 会插入 dsh-rsi-agent
```

`dsh-rsi-agent` 当前不在 registry，第 3 步发布后可用；在那之前只能从本地仓库 `link:`。

## 目录

```text
.
├─ .github/workflows/dsh-compat.yml  # 兼容性校验：push/PR main + 每日巡检 + 手动触发；不兼容自动开 issue
├─ cordis.patch.yml              # bundle patch：dev-domain + 3 个 preset + 顶层 tool-subagent 覆盖
├─ package.json                  # engines.dsh 声明兼容范围；dsh.bundle.patch 指向 cordis.patch.yml
├─ src/
│  ├─ index.ts                   # 包入口：re-export 插件三要素与领域数据
│  ├─ plugin.ts                  # Cordis 插件：inject ['skills','agents']；注册 13 个 Skill；depth 0 注入 persona
│  ├─ domain.ts                  # DEV_DOMAIN：id / version / displayName / persona / 13 个 Skill 元数据
│  ├─ persona.ts                 # LEADER_PERSONA：读 persona/LEADER.md 导出人设正文
│  ├─ persona/LEADER.md          # Leader 人设正文原文（一整块 markdown，唯一来源）
│  └─ firmware.ts                # SKILL.md 读取 / frontmatter 解析 / SkillRegistration 构造
├─ dist-server/                  # 构建产物：pnpm build 生成，git 忽略
├─ skills/                       # 唯一 Skill 源（13 个只读 Skill + dev-test-strategy/references/）
├─ scripts/
│  ├─ copy-assets.mjs            # 把 cordis.patch.yml 等资源复制进 dist-server/
│  ├─ verify-install.mjs         # 18 项包内自检（CLI + 导出纯函数）
│  ├─ dsh-compat.sh              # 兼容性三层校验（安装 → 组合 → 冷启动）
│  ├─ compat-probe.mjs           # 冷启动探针：断言 Skill / preset / 默认 preset
│  └─ dsh-versions.mjs           # 解析待校验的 dsh 版本，产出 CI matrix
├─ tests/                        # 6 个 spec：domain / plugin / patch / firmware-registration / verify-install / compat-probe
├─ tsconfig.json                 # 类型检查
├─ tsconfig.server.json          # 编译到 dist-server/
└─ Makefile                      # check / compat / stage / publish 入口
```

## License

[Apache-2.0](./LICENSE)
