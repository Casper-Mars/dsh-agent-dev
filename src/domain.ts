/**
 * `dev` 领域数据：Skill 元数据与 Leader 人设，不依赖任何外部领域包。
 *
 * 设计要点（任务-02）：
 *   - 单一 Skills 列表，取消 `firmwareSkills` / `baseSkills` 二元结构；
 *   - {@link DevSkill} 只存元数据（name / description / dir），SKILL.md 正文由
 *     加载器从 `dir/SKILL.md` 读取，正文不再内联进 `src/`；
 *   - `dir` 一律由 `import.meta.url` 推导为**绝对路径**：源码态 `src/domain.ts`
 *     与编译态 `dist-server/domain.js` 都解析到包根的 `skills/<name>`。
 */
import { fileURLToPath } from 'node:url'
import { LEADER_PERSONA } from './persona.js'

/** 领域内单个 Skill 的元数据（正文不入库，由加载器从 `dir/SKILL.md` 读取）。 */
export interface DevSkill {
  /** Skill 名，必须与目录名及 frontmatter.name 一致。 */
  readonly name: string
  /** 模型侧可见的一句话描述（与 frontmatter.description 一致）。 */
  readonly description: string
  /** Skill 目录的绝对路径。 */
  readonly dir: string
}

/** `dev` 领域数据。 */
export interface DevDomain {
  /** 领域标识。 */
  readonly id: 'dev'
  /** 领域版本（与 package.json 版本解耦，随领域契约变更递增）。 */
  readonly version: string
  /** 展示名。 */
  readonly displayName: string
  /** Leader 人设正文（主会话常驻）。 */
  readonly personaMarkdown: string
  /** 领域提供的全部 Skill（单一列表，顺序稳定便于 review diff）。 */
  readonly skills: readonly DevSkill[]
}

/** Skill 目录绝对路径：`<包根>/skills/<name>`（源码态 / 编译态同一语义）。 */
function skillDir(name: string): string {
  return fileURLToPath(new URL(`../skills/${name}`, import.meta.url))
}

/** 声明一个 Skill：name / description / dir 一次写全，dir 不允许调用方手拼。 */
function skill(name: string, description: string): DevSkill {
  return { name, description, dir: skillDir(name) }
}

/** `dev` 领域：9 个只读 Skill + Leader 人设。 */
export const DEV_DOMAIN: DevDomain = {
  id: 'dev',
  version: '0.3.0',
  displayName: 'Dev Domain',
  personaMarkdown: LEADER_PERSONA,
  skills: [
    skill('dev-container', '以项目级开发容器执行编码任务：已有 .devcontainer/devcontainer.json 就直接 `devcontainer up/exec`；没有就按依赖清单（package.json / go.mod / pyproject.toml / requirements.txt / pom.xml / Cargo.toml）自动生成配置再构建执行。使用本技能处理任意语言的构建、测试、运行、依赖管理与版本敏感工具链；不用于纯文档产出，也不用 `docker run` 单镜像兜底。'),
    skill('dev-environment', 'Agent 侧开发环境管理规程：把「环境定义」存放在工作区的 <workspace>/.agent-env/（既不是项目仓、也不是 $DSH_HOME），开工前先查后建、一 repo 一容器、交付前按账本与 label 双路核销、收尾按固定顺序回收。本技能只教判断与动作（在哪里放、先查什么、怎么复用、怎么核销），不依赖任何随 skill 分发的脚本；技术栈识别与配置编写由 agent 自己完成。'),
    skill('dev-dispatch-contract', 'Leader 派发契约：10 字段上下文卡片、preset 选择表、Developer/Tester 边界、派发即结束本轮与失败回报格式。'),
    skill('dev-quality-gate', '交付质量门：triage 与独立验收的分工、按仓库脚本跑三件套、Tester 独立重跑、报告模板与 blocker/major/minor 判定。'),
    skill('dev-worktree-git', 'Git worktree 与分支/提交规范：分支命名、worktree 路径约定、Conventional Commits、清理流程与禁止 force push。'),
    skill('dev-test-strategy', '测试策略只做栈检测与路由：按清单文件判断技术栈，指向对应 references/<stack>.md，并给出通用测试原则与未识别栈兜底。'),
    skill('dev-role-developer', 'Developer 子 agent 的执行细则：按栈命令、ref 路由、自检维度、禁止项与交付证据格式。'),
    skill('dev-role-tester', 'Tester 子 agent 的执行细则：按栈命令、验收证据格式、边界覆盖、缺陷分级与禁止项。'),
    skill('dev-retro', '任务复盘规范：触发条件、失败模式分类、单变量改进提案格式（现象/证据/预期指标/回滚），禁止把一次性偏好当规则。'),
  ],
}
