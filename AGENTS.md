# AGENTS.md

面向**在本仓库工作的 agent**。人类安装与使用说明见 [README.md](./README.md)。

## 1. 这个仓库是什么

`dsh-agent-dev` 是 dsh 的开发领域**原生单包**，产物是「人设 + 只读 Skill + agent preset」，不是业务应用。

- **原生单包**：不依赖任何外部 agent core 包；`dsh plugin add` 装本包即可。
- **零工具**：本包不声明任何 tools 实现（无 `tools()`，也无 `toolNames` 字段）；文件 / 命令 / 技能 /
  待办 / 子 agent 能力全部由 `cordis.patch.yml` 的 preset 组合 dsh 内置插件提供。
- **零状态**：不写盘、不建资产目录、没有 bootstrap；13 个 Skill 只从包内 `skills/` 读取并在运行时注册。
- **只读 Skill**：0.2.0 起没有进化能力，Skill 正文不会被运行时改写。
- **人设唯一来源**：`src/persona/LEADER.md`（正文原文），由 `src/persona.ts` 读取后以 `LEADER_PERSONA` 导出，再由插件注入 **depth 0 根会话**；
  `preset-dev-leader` 不挂 persona。`dev-developer` / `dev-tester` 各用自己的 preset persona。
- **环境基线**：dsh `>=0.2.1-rc.2 <0.3.0`（已验证 `0.2.1-rc.2` 与 `0.2.2-rc.1`）、Node ≥ `22.19.0`、pnpm ≥ `11.7.0`。
  兼容范围**唯一真源**是 `package.json` 的 `engines.dsh`：dsh 安装插件时读它，不满足直接拒绝安装。

改代码前先确认改的是哪一层：

| 层 | 位置 | 性质 |
|----|------|------|
| 领域数据 | `src/domain.ts` | `DEV_DOMAIN`：13 个 Skill 的元数据（name / description / dir）与版本 |
| 人设 | `src/persona/LEADER.md` + `src/persona.ts` | Leader 行为规则正文（`.md`）+ 读取导出，注入主会话 |
| 插件行为 | `src/plugin.ts` | Skill 注册 / 原子回滚 / LIFO 反注册 / persona 生命周期 |
| Skill 加载 | `src/firmware.ts` | 读 `SKILL.md`、解析 frontmatter、构造 `SkillRegistration` |
| Skill 正文 | `skills/<name>/SKILL.md` | **唯一 Skill 源**，随包发布、只读 |
| 装配 | `cordis.patch.yml` | 领域插件 + 3 个 preset + 顶层 `tool-subagent` 覆盖 |

## 2. 命令表

在仓库根目录执行。所有命令都应在改动后重跑，不能只看历史结果。

| 命令 | 做什么 | 成功判据 |
|------|--------|----------|
| `pnpm install` | 安装 devDependencies（本包无运行时依赖） | 退出码 0，生成 `node_modules/` |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit` | 退出码 0，无类型错误 |
| `pnpm test` | `vitest run`，6 个 spec 文件 | **96 passed**、退出码 0 |
| `pnpm compat` | `scripts/dsh-compat.sh`：tarball 安装 → `--dump-config` 组合 → 冷启动探针 | 每个目标三层全 `PASS`、退出码 0 |
| `pnpm build` | `clean` → `typecheck` → `tsc -p tsconfig.server.json` → `copy-assets.mjs` | 退出码 0，产出 `dist-server/index.js`、`dist-server/cordis.patch.yml` 与 `dist-server/persona/LEADER.md` |
| `pnpm verify:install` | 校验包内 13 个 `SKILL.md` + 5 个 references | 18 行 `PASS`、退出码 0；有 `FAIL` 退出码 1；参数 / 环境错误退出码 2 |
| `npm pack --dry-run` | 检查发布内容 | 含 `skills/` 18 个文件、`cordis.patch.yml`、`dist-server/cordis.patch.yml`、`dist-server/persona/LEADER.md`、`scripts/verify-install.mjs`；不含 `templates/`、`src/`、`tests/`、`node_modules/` |

`pnpm test` 不带 `--passWithNoTests`：一个用例都没跑会直接失败，不会静默通过。

`pnpm verify:install` 默认检查**包内** `skills/`，未安装也能全 PASS；`--assets <dir>` 只用于手工核查
任意目录下的 `skills/` 布局，不作为默认路径，也不会自动推导 `$DSH_HOME`。

## 3. 目录职责

| 路径 | 职责 | 改动规则 |
|------|------|----------|
| `src/index.ts` | 包入口，re-export 插件三要素与 `DEV_DOMAIN` | 只做 re-export |
| `src/plugin.ts` | Cordis 插件：`name` / `inject` / `apply`；注册 13 个 Skill、depth 0 注入 persona | `name` / `inject` 必须与 `cordis.patch.yml` 逐项一致 |
| `src/domain.ts` | `DEV_DOMAIN`：13 个 Skill 元数据与 `version` | `version` 与 `package.json` 保持同步；`dir` 由 `import.meta.url` 推导，不手拼 |
| `src/persona.ts` | 读 `src/persona/LEADER.md` 导出 `LEADER_PERSONA` | 只改文案（改 `.md`），不改导出名；正文以 `# Dev Leader` 开头 |
| `src/persona/LEADER.md` | Leader 全部行为规则正文原文 | 一整块 markdown，行尾 LF、不留尾部空行；构建时由 `copy-assets.mjs` 复制进 `dist-server/` |
| `src/firmware.ts` | `SKILL.md` 读取 / frontmatter 解析 / `buildFirmwareSkillRegistration` | 只解析 `name` / `description` / `whenToUse`；保持可单测、无副作用 |
| `skills/` | 13 个只读 Skill（含 `dev-test-strategy/references/`） | **唯一 Skill 源**；不新增 `templates/`，不做种子同步 |
| `scripts/verify-install.mjs` | 18 项包内自检 | `EXPECTED_SKILLS` / `EXPECTED_REFERENCE_STACKS` 是检查清单真源 |
| `scripts/copy-assets.mjs` | 把 `cordis.patch.yml` 复制进 `dist-server/` | 不要再引入 `templates/` / seeds 逻辑 |
| `scripts/dsh-compat.sh` | 兼容性三层校验：安装准入 → patch 组合 → 冷启动探针 | 只读外部 dsh 版本，不改本仓库；临时目录用 `mktemp -d` 并清理 |
| `scripts/compat-probe.mjs` | 冷启动探针：断言 13 Skill / 3 preset / 默认 preset | 顶层不得有副作用（被 `tests/compat-probe.spec.ts` 导入）；清单与 `verify-install.mjs` 保持一致 |
| `scripts/dsh-versions.mjs` | 解析 npm `latest` / `next`，产出 CI matrix | 不判断版本是否满足范围，交给 dsh 安装准入 |
| `.github/workflows/dsh-compat.yml` | push/PR main + 每周巡检 + 手动触发的兼容性校验 | `latest` 阻塞、`next` 仅提示；改动需保持 `quality` 与 `compat` 两段 |
| `tests/` | domain / plugin / patch / firmware-registration / verify-install / compat-probe | 改契约或数量必须同步断言 |
| `cordis.patch.yml` | bundle patch：`dev-domain` + 3 个 preset + 顶层 `tool-subagent` | 改 preset / 默认值必须跑测试并装一次核对 |

## 4. 硬规则（违反即返工）

1. **`skills/` 是唯一 Skill 源**：Skill 正文只放 `skills/<name>/SKILL.md`，不在 `src/` 内联，不新建
   `templates/`，不引入 seeds / bootstrap / 资产目录。
2. **frontmatter 只有三个字段**：`name` / `description` / `whenToUse`，且只能是**单行扁平标量**
   （可带成对引号）。正文不得残留 frontmatter；`name` 必须等于目录名。解析器只读这 3 个必填字段，
   额外字段（例如 `user-invocable`）会被静默忽略，因此禁止添加。
3. **Skill 只读注册**：13 个 Skill 由 `ctx.skills.register()` 在运行时注册，注册中途失败必须原子回滚，
   卸载按 LIFO 反注册。不得新增写盘、进化或资产落盘逻辑（`tests/plugin.spec.ts` 断言全程 0 次写盘）。
4. **零工具**：不得新增 `tools()` 实现或 `toolNames` 字段；需要能力就改 preset 组合。
5. **persona 只给 depth 0**：只注入根会话，同一 agent 幂等；子 agent 不继承 Leader 人设。
   `systemPrompt` 缺失时只 warn 降级，不阻断 Skill 注册。
6. **不改外部 core**：本包只依赖 dsh 标准服务（`skills` / `agents` / `systemPrompt`）；需要 core 改动时
   停下来上报，不要改其它仓库。
7. **兼容性声明只有一处**：`package.json` 的 `engines.dsh`。放宽/收缩范围前必须 `pnpm compat <版本>`
   实测通过，并同步 README 的兼容矩阵；不得为了让安装通过而直接改范围。
8. **项目落位**：所有项目落在 `<workspace>/projects/<repo>`（`<workspace>` = `pwd -P` 的真实 cwd，
   **不是** `DSH_HOME`）。新建用 `mkdir -p` + `git init`，克隆用
   `git clone <url> "<workspace>/projects/<repo>"`；既有本地仓库原地使用，不迁移、不复制。
   禁止在 workspace 根、`<workspace>/projects` 根、`$HOME`、`~/project`、`~/agents` 下直接
   `git init` / `git clone`；目标目录已存在且非空时先停下问，不覆盖。
   worktree 落 `<workspace>/projects/.worktrees/<repo>-<type>-<task>-<desc>`。
8. **`cordis.patch.yml` 卫生**：全文不得出现 `rsi-agent`，任何 preset 不得有 `complete` 字段；
   这些都由 `tests/patch.spec.ts` 直接断言。

## 5. 改哪里怎么改

### 配方 A：改一个 Skill 的正文

1. 直接改 `skills/<name>/SKILL.md`（真源只有这一份）；
2. 保持 frontmatter 三字段、`name` = 目录名；
3. `pnpm test`（`tests/domain.spec.ts` 会校验 frontmatter、目录集合与 references 路由）。

### 配方 B：新增 / 修改 references

1. 在 `skills/dev-test-strategy/references/<stack>.md` 新增或修改；
2. 同步 `scripts/verify-install.mjs` 的 `EXPECTED_REFERENCE_STACKS`（检查项总数随之变化）；
3. 同步数量与清单断言：`tests/verify-install.spec.ts` 的 `toHaveLength(5)` / `toBe(18)` /
   `toHaveLength(12)`（缺 1 项时剩余 PASS 数）与 `tests/domain.spec.ts` 的 references 数量 `5`；
4. 同步 README 的目录树、Skill 表与「18/18」说明；
5. `pnpm typecheck && pnpm test && pnpm verify:install`。

### 配方 C：新增一个 Skill

1. 新建 `skills/<new-name>/SKILL.md`（frontmatter 三字段，`name` = 目录名）；
2. 在 `src/domain.ts` 的 `DEV_DOMAIN.skills` 增加 `skill('<new-name>', '<description>')`；
3. 同步 `scripts/verify-install.mjs` 的 `EXPECTED_SKILLS`；
4. 同步测试断言：`tests/domain.spec.ts` 的「恰好 13 个 Skill」与 `tests/verify-install.spec.ts` 的
   `EXPECTED_SKILLS` 长度 / `toBe(18)` / `toHaveLength(17)`；
5. 同步 README 的 Skill 表、目录树与自检条数；
6. `pnpm typecheck && pnpm test && pnpm build && pnpm verify:install`。

### 配方 D：改 preset / 默认 preset

1. 改 `cordis.patch.yml`；
2. `pnpm test`（`tests/patch.spec.ts` 校验：3 个 preset 的 id；`dev-leader` 挂 subagent 控制面但不挂
   persona；`agent-preset-registry.default` = `dev-leader`；**两处** `tool-subagent.agentPreset` =
   `dev-tester`；`allowedAgentPresets` 不含 `dev-leader`；`maxDepth: 1`；不得出现 `complete`）；
3. 用临时 profile 安装一次，`dsh --profile <p> --dump-config` 核对组合树；
4. 同步 README 的「3 个 preset」小节。

## 6. Skill 写作规范

每个 Skill 至少要包含：

1. `## 触发条件`：什么情况下必须读它（`whenToUse` 与它同义，可二者取一）；
2. 流程或细则节：**流程由 persona 承载**（Leader 看 `LEADER_PERSONA`，子 agent 看各自 preset persona），
   Skill 只写角色边界、命令、判据与证据格式。

`## 禁止项` / `## 检查清单` 按 Skill 类型取舍：规则型 Skill（派发契约、质量闸门、角色细则、复盘）
必须写；操作型 Skill（`dev-environment`）除「禁止项」「检查清单」外还可用「常见故障与处置」等小节补充判据，不强制凑标题。

写作要求：

- 写**具体命令、路径、阈值、字段名**，禁止「注意质量」「符合规范」「按最佳实践」这类无法判定的抽象话；
- 引用 references 时必须能落到真实文件（`references/<stack>.md` 必须存在）；
- 阈值用表格或列表给出数值，不用「小 / 大 / 简单」描述；
- 角色边界写清楚「做什么 / 不做什么」，不要让子 agent 自行推断；
- 中文正文，结论先行，不写营销文案。

## 7. 提交规范

- 使用 Conventional Commits：`<type>(<scope>): <描述>`，`type` ∈ `feat|fix|docs|test|chore`；
- 一次逻辑改动一个 commit（Skill 正文与声明 / 自检清单属于同一个逻辑改动）；
- 提交前 `git status --short` 与 `git diff --stat`：只应有预期文件；
- 不提交 `node_modules/`、`dist/`、`dist-server/`、日志、临时文件；
- 不 push、不改主线分支、不改其它仓库；需要推送时由 Leader 明确授权。

## 8. 常见坑

1. **Skill 不会自动加载**：派发卡片必须点名角色 Skill（Developer：`dev-role-developer` +
   `dev-test-strategy`；Tester：`dev-role-tester` + `dev-test-strategy`），并要求回报
   `STACK=… REF=… DETECT=…`。只写「按规范执行」等于没有约束。
2. **`link:` 安装不会替你 build**：profile 的 `main` 指向 `dist-server/index.js`，改完源码必须
   `pnpm build`，否则加载的还是旧产物。
3. **`pnpm test` 的判据是用例数**：成功看 **92 passed**，不要只贴退出码；无 `--passWithNoTests` 后
   空跑会失败，但用例被误删仍可能「少而绿」，改动测试时要核对数量。
4. **`$DSH_HOME` 与 workspace 别混**：`verify:install` 只认包内 `skills/`（或显式 `--assets`），
   不会去读 `$DSH_HOME` 下的旧资产目录。
5. **linked worktree + 默认 `workspace-write` 沙箱**：worktree 的 `.git` 在主仓库、位于工作区之外时，
   `git switch -c` / `git commit` / `git worktree add` 可能报 `Operation not permitted`。开工前先跑
   `dev-worktree-git` 的写权限预检；`GIT_WRITE_BLOCKED` 时不要反复重试或提权，改用
   `delivery_mode=workspace`（当前工作区 + `git diff` 交付）。

## 9. 交付前检查清单

- [ ] `pnpm typecheck` → exit 0
- [ ] `pnpm test` → exit 0，且 **92 passed**（数量随改动更新时，以真实输出为准）
- [ ] `pnpm build` → exit 0，`dist-server/index.js`、`dist-server/cordis.patch.yml` 与 `dist-server/persona/LEADER.md` 存在
- [ ] `pnpm verify:install` → 18/18 PASS、exit 0
- [ ] `npm pack --dry-run` → 清单符合第 2 节断言，无 `templates/` / `src/` / `tests/`
- [ ] 涉及项目路径时：项目在 `<workspace>/projects/<repo>`，worktree 在 `<workspace>/projects/.worktrees/` 下
- [ ] 改过 Skill / references 时：`src/domain.ts`、`verify-install.mjs` 清单、测试断言、README 已同步
- [ ] `git diff --stat` 无越界改动、无临时文件、无构建产物
- [ ] 文档与实现一致：README / AGENTS.md 里引用的路径与命令都真实存在
- [ ] 未 push、未改其它仓库
- [ ] 交付汇报含：分支 + commit、命令与退出码、未覆盖项与残余风险

## 10. 文档维护规则

以下任一变化，必须在**同一个 commit** 里同步 `README.md` 与 `AGENTS.md`：

- 默认 preset 或 preset 的工具面；
- `package.json` 的脚本 / 版本 / `files`；
- Skill 或 references 数量、安装后自检条数；
- 插件行为（Skill 注册、persona 注入、降级语义）；
- 安装方式或 `DSH_HOME` 路径约定。

只改代码不改文档 = 交付不完整；文档里出现未验证的命令或路径 = 直接返工。
