# dsh-agent-dev

> 在本仓库工作的 agent 请先读 [AGENTS.md](./AGENTS.md)。

`dsh-agent-dev` 是 dsh 的**开发领域原生单包**：装这一个包，就能得到

- **Dev Leader persona**：注入主会话（depth 0 根 agent）的常驻 system prompt；
- **8 个只读领域 Skill**：随包发布在 `skills/`，运行时由插件注册进 `ctx.skills`；
- **3 个 agent preset**：`dev-leader` / `dev-developer` / `dev-tester`，由 `cordis.patch.yml` 装配。

零外部核心依赖：不需要额外安装任何 agent core 包，也没有「先编译 core 再装领域包」的前置步骤。
`peerDependencies` 里的 `@deepseek-ai/*` 只提供类型与运行时服务契约，由 dsh 侧提供，用户无需单独安装。
版本 `0.2.0` 起为**原生只读 Skill**：**无进化能力、无资产目录、无 bootstrap**。Skill 正文只来自
包内 `skills/`，不写盘、不被改写；升级或重装会原样覆盖，不存在「已进化内容」需要保留。

## 安装

前置：dsh `0.2.1-rc.2`、Node ≥ `22.19.0`、pnpm ≥ `11.7.0`。

```bash
# 在仓库根目录：安装依赖并编译（产出 dist-server/）
pnpm install
pnpm build

# 装进指定 profile（首次使用会自动初始化 profile）
dsh plugin --profile <p> add link:$PWD
```

发布后可直接按版本安装（registry 上尚无该版本，`npm view dsh-agent-dev` 当前返回 404）：

```bash
dsh plugin --profile <p> add dsh-agent-dev@0.2.0   # 发布后可用
```

`link:` 安装的是当前目录，改动后需要 `pnpm build` 重新生成 `dist-server/`；`main` 指向
`dist-server/index.js`，不编译则加载失败。本包没有运行时依赖，profile 端无需再补装任何包。

### 装完核对组合树

```bash
dsh --profile <p> --dump-config | grep -E "dev-domain|preset-dev-"
```

应能看到：

- `dev-domain`，`inject: ['skills', 'agents']`；
- `agent-preset-registry.default: dev-leader`（决定**主会话** preset）；
- 3 个 preset：`dev-leader`、`dev-developer`、`dev-tester`；
- `tool-subagent` 的 `agentPreset: dev-tester`、`allowedAgentPresets: [dev-developer, dev-tester]`、`maxDepth: 1`。

### 怎么用

装好后主会话就是 Dev Leader。给它「需求 + 验收标准 + 约束」，它会编号 AC、拆任务、派发
`dev-developer` 编码、再派 `dev-tester` 独立验收。Leader 不写业务代码：一律派发子 agent 编码、
一律派发独立 Tester 验收，Leader 只做元操作（读代码 / 写交付说明 / 建 worktree 与分支 / commit 与 push / 环境管理与核销）。

## 自检

仓库内五连（全部应在仓库根目录执行）：

```bash
pnpm typecheck        # tsc --noEmit
pnpm build            # 产出 dist-server/；npm pack 的发布内容依赖它
pnpm test             # vitest run：5 个 spec、82 个用例
pnpm verify:install   # 13/13 PASS：8 个 SKILL.md + 5 个 references
npm pack --dry-run    # 检查发布内容清单（必须在 build 之后执行）
```

判据：

| 命令 | 成功判据 |
|------|----------|
| `pnpm typecheck` | 退出码 0，无类型错误 |
| `pnpm build` | 退出码 0，产出 `dist-server/index.js` 与 `dist-server/cordis.patch.yml` |
| `pnpm test` | **82 passed**、退出码 0（`vitest run`，0 个用例会直接失败） |
| `pnpm verify:install` | 13 行 `PASS`、退出码 0；任一 `FAIL` 退出码 1；目录 / 参数错误退出码 2 |
| `npm pack --dry-run` | build 后共 29 个文件；清单含 `skills/` 13 个文件、`cordis.patch.yml`、`dist-server/cordis.patch.yml`、`scripts/verify-install.mjs`；不含 `templates/`、`src/`、`tests/`、`node_modules/` |

`npm pack --dry-run` 不依赖构建缓存：干净树（没有 `dist-server/`）实测只有 18 个文件且不含任何
运行时产物，所以必须先 `pnpm build` 再打清单。

`verify:install` 默认检查**包内** `skills/`，不需要安装到 profile；`--assets <dir>` 仅用于手工
核查任意目录下的 `skills/` 布局，不是默认路径：

```bash
node scripts/verify-install.mjs --assets /path/to/skills
```

## 发布

发布入口统一收敛在仓库根的 `Makefile`（`make help` 可查全部目标），不要手工拼命令：

| 命令 | 作用 |
|------|------|
| `make check` | 本地验收：build → test → verify → pack（等价于上面的五连，少了单独的 `typecheck`，它已包含在 `build` 里） |
| `make stage-dry` | 演练暂存：`pnpm stage publish --access public --dry-run`，不上传任何东西 |
| `make publish` | 先跑 `check`，全部通过后再 `pnpm stage publish --access public` |

`make publish` 有两道前置保护，任一不满足直接报错退出：

- **工作区必须干净**：`git status --porcelain` 非空就拒绝（先提交或清理再发）；
- **必须在 `main` 分支**：其他分支默认拒绝，确需时用 `ALLOW_BRANCH=1 make publish` 显式跳过。

`pnpm stage` 只是把包**暂存**到 registry，不会立刻对外发布。确认清单无误后再走两步：

```bash
pnpm stage list                 # 查看暂存记录与 stage-id
pnpm stage approve <stage-id>   # 批准发布（含 2FA）
```

当前**未发布 npm**：`npm view dsh-agent-dev` 仍是 404；在那之前装包只能走本地
`dsh plugin --profile <p> add link:$PWD`。

## 目录

```text
.
├─ .gitignore                    # 忽略 node_modules/ 与构建产物
├─ .npmrc                        # pnpm 安装策略（hoist / peer / workspace）
├─ LICENSE                       # Apache-2.0
├─ cordis.patch.yml              # bundle patch：dev-domain + 3 个 preset + 顶层 tool-subagent 覆盖
├─ package.json                  # dsh.bundle.patch 指向 cordis.patch.yml；files 含 skills/
├─ pnpm-lock.yaml                # 依赖锁定
├─ src/
│  ├─ index.ts                   # 包入口：re-export 插件三要素与领域数据
│  ├─ plugin.ts                  # Cordis 插件：inject ['skills','agents']；注册 8 个 Skill；depth 0 注入 persona
│  ├─ domain.ts                  # DEV_DOMAIN：id / version / displayName / persona / 8 个 Skill 元数据
│  ├─ persona.ts                 # LEADER_PERSONA：Leader 的全部行为规则（人设唯一来源）
│  └─ firmware.ts                # SKILL.md 读取 / frontmatter 解析 / SkillRegistration 构造
├─ dist-server/                  # 构建产物：pnpm build 生成，git 忽略，不手工编辑
├─ skills/                       # 唯一的 Skill 源（8 个只读 Skill，随包发布）
│  ├─ dev-environment/SKILL.md
│  ├─ dev-dispatch-contract/SKILL.md
│  ├─ dev-quality-gate/SKILL.md
│  ├─ dev-retro/SKILL.md
│  ├─ dev-role-developer/SKILL.md
│  ├─ dev-role-tester/SKILL.md
│  ├─ dev-test-strategy/
│  │  ├─ SKILL.md                # 只做栈检测与路由
│  │  └─ references/             # go / node-ts / react / harmony-arkts / python
│  └─ dev-worktree-git/SKILL.md
├─ scripts/
│  ├─ copy-assets.mjs            # 把 cordis.patch.yml 复制进 dist-server/
│  └─ verify-install.mjs         # 13 项包内自检（CLI + 导出纯函数）
├─ tests/                        # 5 个 spec：domain / plugin / patch / firmware-registration / verify-install
├─ tsconfig.json                 # 类型检查
├─ tsconfig.server.json          # 编译到 dist-server/
├─ vitest.config.ts
├─ pnpm-workspace.yaml
├─ AGENTS.md
└─ README.md
```

### 运行时装配

1. `cordis.patch.yml` 插入 `dev-domain` 插件、`agent-preset-registry`（default=`dev-leader`）与 3 个 preset；
2. 插件 `apply()` 从 `ctx.skills` 注册 8 个 Skill（正文读 `skills/<name>/SKILL.md`），注册中途失败会
   原子回滚，卸载时按 LIFO 反注册；
3. 插件监听 `agent/created`，只给 **depth 0** 根 agent 注入 `LEADER_PERSONA`；子 agent 使用各自 preset
   的 persona，不继承 Leader 人设。

`inject` 只声明 `['skills', 'agents']`；`systemPrompt` 是 per-agent 服务，缺失时只 warn 降级，不阻断
Skill 注册。

### 8 个 Skill

| Skill | 作用 |
|-------|------|
| `dev-environment` | 唯一的环境规程：定义落 `<workspace>/.agent-env/`、一 repo 一容器、devcontainer 后端、交付前核销、收尾按序回收 |
| `dev-dispatch-contract` | 派发上下文卡片、preset 选择、边界与回报格式 |
| `dev-quality-gate` | 质量闸门（triage 六查）、独立验收分工与缺陷分级 |
| `dev-worktree-git` | worktree / 分支 / commit 规范与写权限预检 |
| `dev-test-strategy` | 只做栈检测与路由，命令在 `references/<stack>.md` |
| `dev-role-developer` | Developer 的执行细则、自检维度与交付证据 |
| `dev-role-tester` | Tester 的验收细则、边界覆盖与报告格式 |
| `dev-retro` | 复盘触发条件、失败模式分类与单变量改进提案 |

全部只读：没有 `templates/`、没有 `src/seeds.ts`、没有 `assets.bootstrap`，也没有任何资产落盘步骤。

### 3 个 preset

| preset | 用途 | 工具面 |
|--------|------|--------|
| `dev-leader` | 主会话默认 preset / 调度者 | fs / bash / skill / todo / subagent / subagent-control / list-agents |
| `dev-developer` | 编码执行者（写操作必须显式指定） | fs / bash / skill / todo + Developer persona |
| `dev-tester` | 验证执行者 / 子 agent 漏传兜底 | fs / bash / skill / todo + Tester persona |

两条独立路径，不要混：

- `agent-preset-registry.default: dev-leader` 决定**主会话** preset；
- `tool-subagent.agentPreset: dev-tester` 只决定**子 agent 漏传 `agent_preset`** 时的兜底，出现在
  `preset-dev-leader` 内与顶层补丁两处；写操作必须由 Leader 显式传 `dev-developer`；
- `allowedAgentPresets: [dev-developer, dev-tester]` + `maxDepth: 1` 限制可派发目标与递归深度
  （`dev-leader` 注册在 registry 中，但不是可派发目标）。

## 迁移

### 从 0.1.x（依赖外部 agent core）升级到 0.2.0

0.1.x 依赖外部 core 与资产目录，0.2.0 改为原生单包。升级步骤：

1. **记录回滚点**：npm 上没有 0.1.x（实测 `npm view dsh-agent-dev` → 404），git 上原本也没有 tag；
   本仓库已为 0.1.0 基线 `b5d0e06` 创建本地 annotated tag `v0.1.0`（未推送），回滚方式见下节。
2. **移除旧 core**（profile 里仍装着时才需要）：`dsh plugin --profile <p> remove dsh-rsi-agent`；若
   `$DSH_HOME/profiles/<p>/package.json` 的 `dsh.profile.bundles` 里仍有该条目，一并手工删除后
   `pnpm install`。
3. **安装本版本**：当前用本地链接（需先 `pnpm build`）：

   ```bash
   dsh plugin --profile <p> add link:$PWD
   ```

   发布后可按版本安装：`dsh plugin --profile <p> add dsh-agent-dev@0.2.0`（发布后可用）。
4. 按「装完核对组合树」检查 `dev-domain` 与 3 个 preset 是否都在，再跑 `pnpm verify:install`。

### 资产目录：不迁移、不读取

旧版本在 `<DSH_HOME>/.dsh-rsi-agent/dev/assets` 下的 Skill 资产**不迁移、不读取**：

- 0.2.0 的 Skill 只来自包内 `skills/`，不会扫描该目录，也不会把其中内容合并进来；
- 其中存在的手工改动（包括对旧 Skill 的修改、新增文件）**一律丢弃**，不要指望升级后仍然生效；
- 需要保留的内容请自行备份到包外；确认无用后可手工删除该目录，本包不会自动删除它。

### 回滚到 0.1.0

npm 上没有 0.1.0（`npm view dsh-agent-dev` → 404），回滚只能在本地按 tag 进行：

```bash
# 1) 检出 0.1.0 基线（本地 annotated tag v0.1.0 → b5d0e06，未推送）
git worktree add /tmp/old v0.1.0

# 2) 装回旧版本（实测安装本身 exit 0）
dsh plugin --profile <p> add link:/tmp/old

# 3) 旧版本的 patch 会插入 dsh-rsi-agent，必须把它一起装回
dsh plugin --profile <p> add dsh-rsi-agent@0.1.x   # 发布后可用
```

实测边界：

- 第 1、2 步当前可执行：`git worktree add /tmp/old v0.1.0` 与 `dsh plugin add link:/tmp/old` 均 exit 0；
- 只做第 1、2 步的 profile 会在启动时找不到 `dsh-rsi-agent`（`ERR_MODULE_NOT_FOUND`），第 3 步是回滚必需项；
- `dsh-rsi-agent` 当前不在 registry（`npm view dsh-rsi-agent` → 404），第 3 步**发布后可用**；
  在那之前只能从本地 dsh-rsi-agent 仓库 `dsh plugin --profile <p> add link:<该仓库路径>`。

回滚只影响包与 profile 依赖；旧资产目录若已被手工删除，旧版本会重新 bootstrap 一份初始种子——这也是
为什么要先备份。
