/**
 * `dev-domain` 插件契约层：声明 Cordis 插件三要素（name / inject / apply）。
 *
 * 本包是 `dev` 领域插件，**不依赖任何 core 私有包**：领域数据由
 * `src/domain.ts` 的 {@link DEV_DOMAIN} 提供，Skill 正文由加载器从
 * `skills/<name>/SKILL.md` 读取。
 *
 * 本任务（任务-02）只做数据层解耦：保留现有 Skill 注册逻辑，`inject` 置空、
 * 移除 install 调用。完整的原生插件改造（persona 生命周期、
 * depth gate、resourceBase 语义、LIFO 反注册）留给任务-03。
 */
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'
import { DEV_DOMAIN } from './domain.js'
import {
  planFirmwareSkillRegistrations,
  type FirmwareSkill,
  type SkippedFirmwareSkill,
} from './firmware.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-domain` 一致）。 */
export const name = 'dev-domain'

/**
 * 依赖服务：无。
 *
 * 任务-02 已去掉依赖注入；`cordis.patch.yml` 里仍写着旧的 inject，
 * 由任务-04 同步（本任务不改该文件）。
 */
export const inject: readonly string[] = []

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
  const service = readService(ctx, 'skills')
  if (
    service !== null &&
    typeof service === 'object' &&
    typeof (service as SkillRegistryLike).register === 'function'
  ) {
    return service as SkillRegistryLike
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 已注册名字的进程内记录（同步查重）
 * ------------------------------------------------------------------ */

/**
 * 每个 ctx 已由本领域注册过的固件 Skill 名。
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

/* ------------------------------------------------------------------ *
 * 注册 / 反注册
 * ------------------------------------------------------------------ */

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
 * 把领域声明的固件 Skill 静态注册进 `ctx.skills`。
 *
 * 降级语义：`ctx.skills` 缺失或不支持 `register()` 时只 warn，返回空数组，
 * **不阻断** install（与 core 的固件注册同口径）。注册中途失败会回滚已注册项
 * 后抛出，调用方负责同时拆卸领域，避免留下「半个注册表」。
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
      'ctx.skills 缺失或不支持 register()，跳过固件 Skill 注册（降级：dev-dispatch-contract / dev-quality-gate 在会话中不可见）',
    )
    return []
  }

  const claimed = claimedNames(ctx)
  const plan = planFirmwareSkillRegistrations(skills, { skip: (name) => claimed.has(name) })
  if (plan.skipped.length > 0) {
    logger.warn(`跳过 ${plan.skipped.length} 个固件 Skill：${describeSkipped(plan.skipped)}`)
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
        logger.warn(`回滚固件 Skill "${registered[index]}" 失败`, rollbackError)
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[dev] 注册固件 Skill 失败（已回滚 [${rolledBack.join(', ')}]）：${detail}`)
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
 * 插件装配
 * ------------------------------------------------------------------ */

/** 插件装配入口。 */
export function apply(ctx: Context): void {
  const logger = createDomainLogger(readService(ctx, 'logger'), 'dev-domain')

  ctx.effect(() => {
    // 领域数据来自 DEV_DOMAIN；register 失败时内部已回滚，不会留下半个注册表。
    const unregisters = registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)

    return () => {
      // 反注册顺序与注册顺序相反（LIFO）。
      for (let index = unregisters.length - 1; index >= 0; index -= 1) {
        try {
          unregisters[index]?.()
        } catch (error) {
          logger.warn('固件 Skill 反注册失败', error)
        }
      }
    }
  }, 'dev-domain:register-skills')
}
