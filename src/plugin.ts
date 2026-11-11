/**
 * `dev-domain` 插件契约层：原生 Cordis 插件（任务-03）。
 *
 * 本包是 `dev` 领域插件，只依赖 dsh 标准服务：
 *   - `skills`：注册 9 个领域 Skill（正文由 `skills/<name>/SKILL.md` 读取）；
 *   - `agents`：监听 agent 生命周期，只给 **depth 0** 根会话注入 Leader persona。
 *
 * 不再依赖旧核心的私有装配服务。领域数据来自 `src/domain.ts`，
 * Skill 正文与 frontmatter 由 `src/firmware.ts` 的加载器读取。
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { DEV_DOMAIN } from './domain.js'
import { LEADER_PERSONA } from './persona.js'
import {
  planFirmwareSkillRegistrations,
  type FirmwareSkill,
  type SkippedFirmwareSkill,
} from './firmware.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-domain` 一致）。 */
export const name = 'dev-domain'

/**
 * 依赖的 dsh 标准服务。
 *
 * `skills` 负责领域 Skill 注册；`agents` 提供 agent 注册表与生命周期事件。
 * persona 所需的 `systemPrompt` 不在此声明：它是 **per-agent** 服务，
 * 由每个 agent 的 scope 通过 `agent.ctx.inject(['systemPrompt'], ...)` 获取；
 * 缺失时只 warn 降级，不阻断 Skill 注册。
 */
export const inject: string[] = ['skills', 'agents']

/** Leader persona 占用的 system prompt 槽位（与 dsh-persona 的根槽位一致）。 */
const PERSONA_SECTION = 'deployment:persona-prefix'

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
function readService(ctx: Context, serviceName: string): unknown {
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
): Array<() => void> {
  const registry = readSkillRegistry(ctx)
  if (registry === undefined) {
    logger.warn(
      'ctx.skills 缺失或不支持 register()，跳过领域 Skill 注册（降级：8 个 dev-* Skill 在会话中不可见）',
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
      verifyRegistrationWinner(registry, registration, logger)
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
  readonly header?: { readonly delegationDepth?: number }
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

interface PersonaEntry {
  readonly agent: AgentLike
  readonly fiber: Fiber
}

/**
 * 根会话 Leader persona 注入器。
 *
 * - `agent/created`：显式 depth gate，仅 depth 0；同一 agent 幂等；
 * - `agent/disposed`：dispose 自己记录的 fiber 并从 Map 删除；
 * - `installExisting()`：补装插件加载前已经存在的 agent；
 * - `disposeAll()`：插件卸载时清理所有残留 fiber。
 */
class LeaderPersonaInjector {
  private readonly entries = new Map<string, PersonaEntry>()
  private readonly injected = new WeakSet<object>()
  private readonly warned = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly logger: DomainLogger,
  ) {}

  /** 补装 `ctx.agents.list()` 中已存在的根 agent（热重载 / 晚加载场景）。 */
  installExisting(): void {
    const registry = readAgentRegistry(this.ctx)
    if (registry === undefined) {
      this.warnOnce('agents-missing', 'ctx.agents 不可用，跳过已存在 agent 的 Leader persona 补装')
      return
    }
    let agents: readonly AgentLike[]
    try {
      agents = registry.list()
    } catch (error) {
      this.logger.warn('读取 ctx.agents.list() 失败，跳过 Leader persona 补装', error)
      return
    }
    for (const agent of agents) {
      void this.install(agent)
    }
  }

  /** `agent/created` 处理：depth gate + 幂等 + 注入。 */
  async onCreated(payload: { agent: AgentLike }): Promise<void> {
    await this.install(payload.agent)
  }

  /** `agent/disposed` 处理：只清理同一个 agent 实例对应的 fiber。 */
  onDisposed(agent: AgentLike): void {
    const entry = this.entries.get(agent.id)
    if (entry === undefined) return
    if (entry.agent !== agent) {
      this.logger.warn(
        `agent/disposed 的实例与记录不一致（id=${agent.id}），保留当前 fiber 交给它自己的 disposed 清理`,
      )
      return
    }
    void this.disposeEntry(entry, 'agent disposed')
  }

  /** 插件卸载：清理所有仍记录的 fiber（等待全部释放完成）。 */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry, 'plugin unload')))
  }

  private async install(agent: AgentLike): Promise<void> {
    if (agent === null || typeof agent !== 'object') return
    if (this.injected.has(agent)) return
    this.injected.add(agent)

    let depth: number
    try {
      depth = delegationDepthOf(agent)
    } catch (error) {
      this.logger.warn(`无法读取 agent ${String(agent.id)} 的 delegationDepth，跳过 persona 注入`, error)
      return
    }
    if (depth !== 0) return

    const systemPrompt = peekService(agent.ctx, 'systemPrompt')
    if (!isSystemPromptLike(systemPrompt)) {
      this.warnOnce(
        'systemPrompt-missing',
        'agent scope 缺少 systemPrompt 服务，Leader persona 降级为不注入（Skill 注册不受影响）',
      )
      // 不记住这次失败：systemPrompt 之后可用时（例如 resume）仍要能补装。
      this.injected.delete(agent)
      return
    }

    const existing = this.entries.get(agent.id)
    if (existing !== undefined) {
      if (existing.agent === agent) return
      // 同一 id 的新 agent（resume / clear）：先释放旧实例的 fiber。
      void this.disposeEntry(existing, 'same id replaced by a new agent instance')
    }

    let fiber: Fiber
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scoped: Context) => {
        scoped.effect(() => {
          const prompt = (scoped as unknown as { systemPrompt: SystemPromptLike }).systemPrompt
          const disposeSection = prompt.section({
            name: PERSONA_SECTION,
            order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: LEADER_PERSONA,
          })
          return disposeSection
        }, 'dev-domain:leader-persona')
      }) as Fiber
    } catch (error) {
      this.logger.warn(`为 agent ${String(agent.id)} 注入 Leader persona 失败`, error)
      this.injected.delete(agent)
      return
    }

    const entry: PersonaEntry = { agent, fiber }
    this.entries.set(agent.id, entry)

    try {
      await fiber
    } catch (error) {
      this.logger.warn(`Leader persona fiber 加载失败（agent=${String(agent.id)}）`, error)
      this.injected.delete(agent)
      if (this.entries.get(agent.id) === entry) this.entries.delete(agent.id)
    }
  }

  private async disposeEntry(entry: PersonaEntry, reason: string): Promise<void> {
    if (this.entries.get(entry.agent.id) === entry) {
      this.entries.delete(entry.agent.id)
    }
    try {
      await entry.fiber.dispose()
    } catch (error) {
      this.logger.warn(`释放 Leader persona fiber 失败（${reason}）`, error)
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

/** 插件装配入口。 */
export function apply(ctx: Context): void {
  const logger = createDomainLogger(readService(ctx, 'logger'), 'dev-domain')

  // 1) 9 个领域 Skill：注册 / 回滚 / LIFO 反注册全部交给 ctx.effect 管理。
  ctx.effect(() => {
    const unregisters = registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)

    return () => {
      // 反注册顺序与注册顺序相反（LIFO）。
      for (let index = unregisters.length - 1; index >= 0; index -= 1) {
        try {
          unregisters[index]?.()
        } catch (error) {
          logger.warn('领域 Skill 反注册失败', error)
        }
      }
    }
  }, 'dev-domain:register-skills')

  // 2) Leader persona：agent 生命周期监听 + 插件卸载统一清理。
  const personas = new LeaderPersonaInjector(ctx, logger)
  const events = ctx as unknown as AgentEventContext

  ctx.effect(() => {
    const offCreated = events.on('agent/created', (payload) => personas.onCreated(payload))
    const offDisposed = events.on('agent/disposed', ({ agent }) => personas.onDisposed(agent))

    return async () => {
      offCreated()
      offDisposed()
      await personas.disposeAll()
    }
  }, 'dev-domain:leader-persona-lifecycle')

  // 3) 补装插件加载前已经存在的根 agent（幂等，created 仍会正常触发）。
  personas.installExisting()
}
