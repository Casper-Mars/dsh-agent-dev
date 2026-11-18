/**
 * `dev-domain` 插件契约层：原生 Cordis 插件（任务-03）。
 *
 * 本包是 `dev` 的宿主层插件：
 *   - `agents`：监听 agent 生命周期，只给 **depth 0** 且 preset 为 `dev-leader` 的
 *     根会话注入 Leader persona。
 *
 * 领域 Skill 不在本层注册：三个 preset 各自的 `assets-*` 模块随各自的常驻组合
 * 挂载，注册进对应 preset 的 scope 层，这样三个角色的技能面互不串味。
 * 领域数据来自 `src/domain.ts`，Skill 正文与 frontmatter 由 `src/firmware.ts`
 * 的加载器读取。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { DEV_DOMAIN } from './domain.js'
import {
  planFirmwareSkillRegistrations,
  type FirmwareSkill,
  type SkippedFirmwareSkill,
} from './firmware.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-domain` 一致）。 */
export const name = 'dev-domain'

/** 本包的主 preset id；Leader persona 只注入给这个 preset 的根会话。 */
export const ROLE = 'dev-leader'

/**
 * 依赖的 dsh 标准服务。
 *
 * 只需要 `agents`：监听 agent 生命周期，把 dev 会话的权限预设切到完全访问。
 * persona 不再在宿主层注入——它随 preset 层的 `dev-assets-leader` 注册。
 */
export const inject: string[] = ['agents']

/**
 * dev 角色需要的权限预设。
 *
 * 编码 / 构建 / 验收都要指挥宿主 Docker 与 devcontainer，`workspace-write` + `ask`
 * 会在每次 bash 弹确认，实际不可用。cto / pm 不在这里切换，走进程默认（见部署补丁的
 * `defaultPreset: workspace-write`）。
 */
const ROLE_PERMISSION_PRESET = 'danger-full-access'

/** 属于本包的三个 preset；只有它们会被切到完全访问。 */
const DEV_PRESETS = new Set(['dev-leader', 'dev-developer', 'dev-tester'])

/** `permissionPresets` 服务的最小结构（只用到读当前值 + 切换）。 */
interface PermissionPresetsLike {
  current(session: unknown): string
  set(session: unknown, name: string): void
}

/* ------------------------------------------------------------------ *
 * 日志（本地最小包装，基于 `ctx.logger`）
 * ------------------------------------------------------------------ */

/** 领域内只用到 `warn`；缺失 logger 时退回 `console.warn`。 */
export interface DomainLogger {
  warn(message: string, error?: unknown): void
}

/** `ctx.logger` 的最小结构。 */
interface LoggerLike {
  warn?: (...args: unknown[]) => void
}

/** 读取任意来源的 logger（ctx.logger / readService 结果），包成带领域前缀的 warn。 */
export function createDomainLogger(raw: unknown, scope: string): DomainLogger {
  const logger =
    raw !== null && typeof raw === 'object' ? (raw as LoggerLike) : undefined
  const prefix = `[${scope}]`
  return {
    warn(message: string, error?: unknown): void {
      if (typeof logger?.warn === 'function') {
        if (error === undefined) logger.warn(`${prefix} ${message}`)
        else logger.warn(`${prefix} ${message}`, error)
        return
      }
      if (error === undefined) console.warn(`${prefix} ${message}`)
      else console.warn(`${prefix} ${message}`, error)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 服务探测（与 core 同款容错：get() 优先，退化到属性读取）
 * ------------------------------------------------------------------ */

/** 读取服务实例；缺失或抛错时返回 `undefined`（不阻断装配）。 */
export function readService(ctx: Context, serviceName: string): unknown {
  const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, serviceName)
      if (value !== undefined) return value
    } catch {
      // 落到属性读取
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[serviceName]
  } catch {
    return undefined
  }
}

/**
 * 只探测服务是否存在，不要求当前 ctx 声明过 `inject`。
 *
 * `agent.ctx` 是 per-agent scope：在 `inject(['systemPrompt'], ...)` 之前直接读
 * `agent.ctx.systemPrompt` 会抛 `cannot get property ... without inject`。
 * `ctx.reflect.get(name, false)` 是 Cordis 暴露的非严格读取入口，
 * 服务未提供时返回 `undefined`，用于「缺失就 warn 降级」的判断。
 */
function peekService(ctx: Context, serviceName: string): unknown {
  const reflect = (ctx as unknown as {
    reflect?: { get?: (name: string, strict?: boolean) => unknown }
  }).reflect
  if (reflect !== undefined && typeof reflect.get === 'function') {
    try {
      return reflect.get.call(reflect, serviceName, false)
    } catch {
      // 落到 readService
    }
  }
  return readService(ctx, serviceName)
}

/* ------------------------------------------------------------------ *
 * Skill 注册
 * ------------------------------------------------------------------ */

/** `ctx.skills.get()` 返回的最小结构（只读核验用）。 */
interface SkillDefinitionLike {
  readonly name?: string
  readonly provider?: string
  readonly content?: string
}

/** `ctx.skills` 的最小结构：只依赖 dsh-skill 的公开 `register()`（`get()` 可选）。 */
interface SkillRegistryLike {
  register(skill: SkillRegistration): () => void
  get?(name: string): Promise<SkillDefinitionLike | undefined>
}

/** 读取 `ctx.skills`；缺失或不支持 `register()` 时返回 `undefined`（降级信号）。 */
function readSkillRegistry(ctx: Context): SkillRegistryLike | undefined {
  const service = peekService(ctx, 'skills')
  if (
    service !== null &&
    typeof service === 'object' &&
    typeof (service as SkillRegistryLike).register === 'function'
  ) {
    return service as SkillRegistryLike
  }
  return undefined
}

/**
 * 每个 ctx 已由本领域注册过的 Skill 名。
 *
 * `ctx.skills.list()` / `get()` 都是**异步** API，`apply()` 内无法同步等待，
 * 因此同步查重只能覆盖「本领域自己注册过的名字」（重复 apply / 重复 install
 * 的真实来源）。跨来源重名由 dsh-skill 保证：同一层同名 runtime 条目 first-wins
 * （后来者拿到 no-op disposer，不报错），若上游将来接管 Skill 注册，
 * 其条目先注册即胜出，语义与「跳过」一致；这种情况由
 * {@link verifyRegistrationWinner} 异步补一条 warn。
 */
const registeredByContext = new WeakMap<object, Set<string>>()

/** 取（必要时创建）某个 ctx 的已注册名字集合。 */
function claimedNames(ctx: Context): Set<string> {
  const key = ctx as unknown as object
  let names = registeredByContext.get(key)
  if (names === undefined) {
    names = new Set<string>()
    registeredByContext.set(key, names)
  }
  return names
}

/** 把跳过项汇总成一条可读的 warn 文案。 */
function describeSkipped(skipped: readonly SkippedFirmwareSkill[]): string {
  return skipped
    .map((item) =>
      item.reason === 'duplicate-declaration'
        ? `${item.name}（声明内重名）`
        : `${item.name}（注册表已有同名 Skill，保留已有条目）`,
    )
    .join('、')
}

/**
 * 注册完成后异步核验「最终胜出的条目是否就是我们这份」。
 *
 * 只在发现被其它来源抢占时 warn（不改变行为、不抛错）：filesystem / 项目级
 * Skill 可以合法覆盖同名 runtime 注册，领域侧需要让用户看到这条事实。
 */
function verifyRegistrationWinner(
  registry: SkillRegistryLike,
  registration: SkillRegistration,
  logger: DomainLogger,
): void {
  const get = registry.get
  if (typeof get !== 'function') return

  let pending: Promise<SkillDefinitionLike | undefined>
  try {
    pending = Promise.resolve(get.call(registry, registration.name))
  } catch {
    return
  }

  void pending.then(
    (found) => {
      if (found === undefined) {
        logger.warn(`固件 Skill "${registration.name}" 注册后仍不可见（skills.get() 返回 undefined）`)
        return
      }
      if (typeof found.provider === 'string' && found.provider !== 'runtime') {
        logger.warn(
          `同名 Skill "${registration.name}" 已由 provider "${found.provider}" 提供，领域固件版本未生效（保留已有条目）`,
        )
        return
      }
      if (typeof found.content === 'string' && found.content !== registration.content) {
        logger.warn(
          `同名 Skill "${registration.name}" 的正文与领域固件版本不一致（可能已被其它来源抢先注册），保留已有条目`,
        )
      }
    },
    () => {
      // 核验是尽力而为：`get()` 失败（provider 抖动 / 已卸载）不应影响安装。
    },
  )
}

/**
 * 把领域声明的 9 个 Skill 静态注册进 `ctx.skills`。
 *
 * 降级语义：`ctx.skills` 缺失或不支持 `register()` 时只 warn，返回空数组，
 * **不阻断**插件装配。注册中途失败会回滚已注册项后抛出，调用方负责同时拆卸
 * 领域，避免留下「半个注册表」。
 *
 * @returns 与注册顺序一致的 unregister 数组（调用方按 LIFO 反注册）。
 */
export function registerDomainFirmwareSkills(
  ctx: Context,
  skills: readonly FirmwareSkill[] | undefined = DEV_DOMAIN.skills,
  logger: DomainLogger = createDomainLogger(readService(ctx, 'logger'), 'dev-domain'),
  options: { readonly verifyWinner?: boolean } = {},
): Array<() => void> {
  const registry = readSkillRegistry(ctx)
  if (registry === undefined) {
    logger.warn(
      `ctx.skills 缺失或不支持 register()，跳过领域 Skill 注册（降级：${skills?.length ?? 0} 个 dev-* Skill 在会话中不可见）`,
    )
    return []
  }

  const claimed = claimedNames(ctx)
  const plan = planFirmwareSkillRegistrations(skills, { skip: (name) => claimed.has(name) })
  if (plan.skipped.length > 0) {
    logger.warn(`跳过 ${plan.skipped.length} 个领域 Skill：${describeSkipped(plan.skipped)}`)
  }

  const unregisters: Array<() => void> = []
  const registered: string[] = []
  try {
    for (const registration of plan.registrations) {
      const unregister = registry.register(registration)
      if (typeof unregister !== 'function') {
        throw new TypeError(
          `ctx.skills.register("${registration.name}") 未返回 unregister 函数（实际为 ${typeof unregister}）`,
        )
      }
      unregisters.push(unregister)
      registered.push(registration.name)
      claimed.add(registration.name)
      // 核验用的是宿主层读取：注册发生在 preset scope 时会永远读不到，
      // 调用方（三个 assets 插件）因此会关掉它，避免每次会话启动刷假告警。
      if (options.verifyWinner ?? true) verifyRegistrationWinner(registry, registration, logger)
    }
  } catch (error) {
    const rolledBack: string[] = []
    for (let index = unregisters.length - 1; index >= 0; index -= 1) {
      try {
        unregisters[index]?.()
        claimed.delete(registered[index] as string)
        rolledBack.push(registered[index] as string)
      } catch (rollbackError) {
        logger.warn(`回滚领域 Skill "${registered[index]}" 失败`, rollbackError)
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[dev] 注册领域 Skill 失败（已回滚 [${rolledBack.join(', ')}]）：${detail}`)
  }

  // 反注册时同步释放查重占位，保证「卸载后再装」可以重新注册。
  return unregisters.map((unregister, index) => () => {
    try {
      unregister()
    } finally {
      claimed.delete(registered[index] as string)
    }
  })
}

/* ------------------------------------------------------------------ *
 * Leader persona 生命周期（per-agent，depth 0 only）
 * ------------------------------------------------------------------ */

/** `agent.session.header` 的最小结构。 */
interface AgentSessionLike {
  readonly header?: {
    readonly delegationDepth?: number
    /** 会话创建时记录的 preset id（durable）。 */
    readonly agentPreset?: string
  }
}

/** 本模块用到的 agent 结构（不引入 dsh-agent 类型依赖）。 */
interface AgentLike {
  readonly id: string
  readonly ctx: Context
  readonly session?: AgentSessionLike
  readonly options?: { readonly subagentDepth?: number }
}

/** `agent/created` / `agent/disposed` 的 payload。 */
interface AgentEventContext {
  on(
    event: 'agent/created',
    listener: (payload: {
      agent: AgentLike
      source: string
      signal?: AbortSignal
    }) => void | Promise<void>,
  ): () => void
  on(event: 'agent/disposed', listener: (payload: { agent: AgentLike }) => void): () => void
}

/** `systemPrompt.section()` 的最小入参。 */
interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly complete?: boolean
}

/** `ctx.systemPrompt` 的最小结构。 */
interface SystemPromptLike {
  section(section: PromptSectionLike): () => void
  getSectionOrder(name: string): number
}

/** `ctx.agents` 的最小结构。 */
interface AgentRegistryLike {
  list(): readonly AgentLike[]
}

function isSystemPromptLike(value: unknown): value is SystemPromptLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as SystemPromptLike).section === 'function' &&
    typeof (value as SystemPromptLike).getSectionOrder === 'function'
  )
}

function readAgentRegistry(ctx: Context): AgentRegistryLike | undefined {
  const service = peekService(ctx, 'agents')
  if (
    service !== null &&
    typeof service === 'object' &&
    typeof (service as AgentRegistryLike).list === 'function'
  ) {
    return service as AgentRegistryLike
  }
  return undefined
}

/**
 * 读取 agent 的委托深度。
 *
 * 与 `dsh-subagent` 的 `delegationDepthOf` 同口径：
 * `max(session.header.delegationDepth ?? 0, options.subagentDepth ?? 0)`。
 * persisted header 是权威且单调的，runtime options 只能加深、不能降低。
 */
export function delegationDepthOf(agent: AgentLike): number {
  const persisted = agent.session?.header?.delegationDepth ?? 0
  const runtime = agent.options?.subagentDepth
  if (
    runtime !== undefined &&
    (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))
  ) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  return Math.max(persisted, runtime ?? 0)
}

/** `agentPresets` 的最小结构：只读当前 agent 挂载的 preset id。 */
interface AgentPresetsLike {
  composedPreset(ctx: Context): string | undefined
}

/**
 * 读 agent 当前挂载的 preset id。
 *
 * 优先 `agentPresets.composedPreset()`（运行时绑定，晚选 preset 也准），
 * 回退到会话 header 的持久化记录。两者都拿不到时返回 `undefined`——此时按
 * 「无法判定」处理，保留旧的注入行为，避免在没装 preset 服务的宿主上把人设静默丢掉。
 */
function composedPresetOf(agent: AgentLike): string | undefined {
  const service = peekService(agent.ctx, 'agentPresets')
  if (service !== null && typeof service === 'object') {
    const composedPreset = (service as AgentPresetsLike).composedPreset
    if (typeof composedPreset === 'function') {
      try {
        const value = composedPreset.call(service, agent.ctx)
        if (typeof value === 'string' && value.length > 0) return value
      } catch {
        // 落到 header
      }
    }
  }

  const persisted = agent.session?.header?.agentPreset
  if (typeof persisted === 'string' && persisted.length > 0) return persisted
  return undefined
}

/**
 * 根会话权限切换器。
 *
 * persona 已下沉到 preset 层的 `dev-assets-leader`；宿主层这里只保留一件
 * 必须发生在 agent 创建时的事：把 dev 会话的权限预设切到 `danger-full-access`。
 * 它不能放进 preset（权限是会话级状态，不是 preset 组合的一部分），
 * 因此仍由宿主插件监听 agent 生命周期。
 *
 * - `agent/created`：切权限（仅 dev presets，幂等）；
 * - `installExisting()`：补装插件加载前已存在的 agent；
 * - 权限服务缺失 / 未就绪时只 warn，降级为进程默认（人设红线兜底）。
 */
class LeaderPermissionSwitcher {
  private readonly warned = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly logger: DomainLogger,
  ) {}

  /** 补装 `ctx.agents.list()` 中已存在的根 agent（热重载 / 晚加载场景）。 */
  installExisting(): void {
    const registry = readAgentRegistry(this.ctx)
    if (registry === undefined) {
      this.warnOnce('agents-missing', 'ctx.agents 不可用，跳过已存在 agent 的权限预设切换')
      return
    }
    let agents: readonly AgentLike[]
    try {
      agents = registry.list()
    } catch (error) {
      this.logger.warn('读取 ctx.agents.list() 失败，跳过权限预设切换', error)
      return
    }
    for (const agent of agents) this.applyRolePermission(agent)
  }

  /** `agent/created` 处理：只做权限预设切换。 */
  onCreated(payload: { agent: AgentLike }): void {
    this.applyRolePermission(payload.agent)
  }

  /**
   * 把 dev 会话切到「完全访问」。
   *
   * 只在 preset 属于本包时执行（不碰 cto / pm 的会话）；幂等——已经是目标值就跳过。
   * 失败只 warn：权限服务缺失或尚未就绪时，降级为进程默认，由人设红线兜底。
   */
  private applyRolePermission(agent: AgentLike): void {
    // 子 agent 不继承 dev 的全权限：主智能体以 workspace-write 运行，
    // 它派出的 dev 子 agent 也必须留在同一权限档，否则等于隐式提权。
    if ((agent.options?.subagentDepth ?? 0) > 0) return
    const presetId = composedPresetOf(agent)
    if (presetId === undefined || !DEV_PRESETS.has(presetId)) return
    if (agent.session === undefined) return

    const service = peekService(agent.ctx, 'permissionPresets')
    if (service === null || typeof service !== 'object') return
    const candidate = service as Partial<PermissionPresetsLike>
    if (typeof candidate.set !== 'function') return

    try {
      if (typeof candidate.current === 'function' && candidate.current(agent.session) === ROLE_PERMISSION_PRESET) return
      candidate.set(agent.session, ROLE_PERMISSION_PRESET)
    } catch (error) {
      this.logger.warn(`切换 dev 会话权限预设失败（preset=${presetId}）`, error)
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.logger.warn(message)
  }
}

/* ------------------------------------------------------------------ *
 * 插件装配
 * ------------------------------------------------------------------ */

/** 插件装配入口：只做 dev 会话的权限预设切换；persona 与 Skill 都在 preset 层。 */
export function apply(ctx: Context): void {
  const logger = createDomainLogger(readService(ctx, 'logger'), 'dev-domain')
  const switcher = new LeaderPermissionSwitcher(ctx, logger)
  const events = ctx as unknown as AgentEventContext

  ctx.effect(() => {
    const offCreated = events.on('agent/created', (payload) => switcher.onCreated(payload))
    return () => {
      offCreated()
    }
  }, 'dev-domain:permission-preset')

  // 补装插件加载前已经存在的 agent（幂等，created 仍会正常触发）。
  switcher.installExisting()
}
