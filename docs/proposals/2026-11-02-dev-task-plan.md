# 新增 dev-task-plan：开发任务层拆解

- 状态：已实施
- 日期：2026-11-02
- 范围：`dsh-dev-domain`

## 1. 结论

新增固件技能 `dev-task-plan`，负责**开发任务拆解**：把已评审的 PRD 与技术方案拆成可分配给开发人员的协调单位，输出负责人、依赖 DAG、里程碑、任务级验收与集成点。

`dev-decompose` 仍保留，但职责收窄为**编码操作拆解**：一个开发任务内部的文件、函数、步骤与提交顺序。两者不是同一层。

## 2. 两层区别

| 层级 | 拆什么 | 单位 | 技能 |
|---|---|---|---|
| 开发任务 | 谁做什么、依赖与交接、并行与里程碑 | 一个负责人可独立验收的交付增量，可跨多个 PR / 天 | `dev-task-plan` |
| 编码操作 | 一个任务内部具体怎么改代码 | 一个 PR / 一次会话的文件与步骤 | `dev-decompose` |

`dev-decompose` 现有的「≤10 文件 / ≤400 行 / 一个分支一个 PR / 纵切 / 先骨架后填充」都是编码操作判据，不能用来给多个开发人员分工。

## 3. 技能结构

按 skill-creator 的结构：metadata 负责触发，正文只有「工作流程 + 规则」，判据与模板放 references / assets。

- 工作流程：分析交付 → 定任务粒度 → 设计依赖图 → 派负责人与里程碑 → 写计划 → 自检交付
- 判据：`references/checklists.md`（8 项）
- 模板：`assets/task-plan-template.md`

## 4. 验收

- `dev-task-plan` 作为固件注册；`verify:install` 14/14。
- 测试 59 条全绿（新增固件后计数从 13 → 14、2 → 3）。
- README 的运行态 Skill 数从 11 → 12。

## 5. 未决

- `dev-decompose` 是否改名为 `dev-code-plan` 以彻底消除歧义；当前先靠 description 与 README 划清边界。
