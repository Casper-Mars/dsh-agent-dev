/**
 * `src/plugin.ts` 的装配契约（任务-03 原生 Cordis 插件）。
 *
 * 这里**不引入旧核心包、不启动真实 core**：用最小 fake `ctx` 复刻插件
 * 依赖的三样东西 —— `skills` 注册表、`agents` 生命周期事件、per-agent
 * `systemPrompt` 服务 —— 从而可以在毫秒级验证注册参数、depth gate、幂等、
 * 卸载顺序与「注册全程只读」。
 */
import { dirname } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 把 `node:fs` 的写盘 API 全部换成 spy（真实实现保留）。
 *
 * 这样 `src/firmware.ts` 里的 `readFileSync` 仍是真实读取，而任何组件一旦
 * 尝试写盘都会被记录 —— 「注册只读」这条验收因此可以被直接断言。
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const wrap = (fn: unknown) => vi.fn(fn as (...args: unknown[]) => unknown)
  return {
    ...actual,
    writeFileSync: wrap(actual.writeFileSync),
    writeFile: wrap(actual.writeFile),
    appendFileSync: wrap(actual.appendFileSync),
    appendFile: wrap(actual.appendFile),
    mkdirSync: wrap(actual.mkdirSync),
    mkdir: wrap(actual.mkdir),
    rmSync: wrap(actual.rmSync),
    rm: wrap(actual.rm),
    unlinkSync: wrap(actual.unlinkSync),
    unlink: wrap(actual.unlink),
    renameSync: wrap(actual.renameSync),
    rename: wrap(actual.rename),
    copyFileSync: wrap(actual.copyFileSync),
    copyFile: wrap(actual.copyFile),
    truncateSync: wrap(actual.truncateSync),
    createWriteStream: wrap(actual.createWriteStream),
  }
})

import * as fs from 'node:fs'
import { apply } from '../src/plugin'
import { DEV_DOMAIN } from '../src/domain'
import { LEADER_PERSONA } from '../src/persona'

/* ------------------------------------------------------------------ *
 * 最小 fake Cordis 运行时
 * ------------------------------------------------------------------ */

/** 可 await 的 fiber（`await fiber` 立即完成；`dispose()` 幂等）。 */
class FakeFiber {
  disposed = false

  constructor(private readonly onDispose: () => unknown = () => {}) {}

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.onDispose()
  }

  // 注意：resolve 值必须是 undefined —— resolve(this) 会让 thenable 递归自解析，
  // await 永远不返回（表现为测试挂死）。
  then<TResult1 = void, TResult2 = never>(
    onFulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => (onFulfilled ? onFulfilled() : (undefined as unknown as TResult1)))
      .catch((error) => {
        if (onRejected) return onRejected(error) as TResult2
        throw error
      })
  }
}

type Listener = (payload: unknown) => unknown

/** 复刻插件用到的 Context 子集。 */
class FakeContext {
  readonly services = new Map<string, unknown>()
  readonly effects: Array<{ label: string; fiber: FakeFiber }> = []
  readonly injectCalls: string[][] = []
  readonly injectFibers: FakeFiber[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  readonly reflect = {
    get: (name: string): unknown => this.services.get(name),
  }

  constructor(services: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(services)) this.services.set(key, value)
  }

  get(name: string): unknown {
    return this.services.get(name)
  }

  setService(name: string, value: unknown): void {
    this.services.set(name, value)
  }

  /** 立即执行装配回调，把返回的清理函数包成 fiber。 */
  effect(callback: () => unknown, label = 'effect'): FakeFiber {
    const result = callback()
    const fiber = new FakeFiber(async () => {
      if (typeof result === 'function') await (result as () => unknown)()
    })
    this.effects.push({ label, fiber })
    return fiber
  }

  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  async emit(event: string, payload: unknown): Promise<void> {
    const set = this.listeners.get(event)
    if (set === undefined) return
    for (const listener of [...set]) await listener(payload)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  /** per-agent scope：`inject(deps, cb)` 提供带 `systemPrompt` 的 scoped ctx。 */
  inject(deps: string[], callback: (scoped: unknown) => unknown): FakeFiber {
    this.injectCalls.push([...deps])
    const scopedFibers: FakeFiber[] = []
    const services = this.services
    const scoped = {
      effect: (fn: () => unknown): FakeFiber => {
        const dispose = fn()
        const fiber = new FakeFiber(async () => {
          if (typeof dispose === 'function') await dispose()
        })
        scopedFibers.push(fiber)
        return fiber
      },
      get systemPrompt(): unknown {
        return services.get('systemPrompt')
      },
    }

    const result = callback(scoped)
    const fiber = new FakeFiber(async () => {
      for (const scopedFiber of [...scopedFibers].reverse()) await scopedFiber.dispose()
      if (typeof result === 'function') await (result as () => unknown)()
    })
    this.injectFibers.push(fiber)
    return fiber
  }
}

/** 记录注册 / 反注册顺序的假 skills 注册表。 */
function createSkillRegistry() {
  const registered: string[] = []
  const unregistered: string[] = []
  const definitions = new Map<string, Record<string, unknown>>()

  return {
    registered,
    unregistered,
    definitions,
    register(registration: Record<string, unknown>) {
      const name = registration.name as string
      registered.push(name)
      definitions.set(name, registration)
      let done = false
      return () => {
        if (done) return
        done = true
        unregistered.push(name)
        definitions.delete(name)
      }
    },
    get(name: string) {
      return Promise.resolve(definitions.get(name))
    },
  }
}

/** 记录 section 注册与释放的假 systemPrompt。 */
function createSystemPrompt() {
  const sections: Array<{ name: string; order: number; text: string; disposed: boolean }> = []
  return {
    sections,
    section(input: { name: string; order: number; text: string }) {
      const entry = { ...input, disposed: false }
      sections.push(entry)
      return () => {
        entry.disposed = true
      }
    },
    getSectionOrder(name: string) {
      return name === 'DEPLOYMENT_PERSONA_PREFIX' ? 100 : 0
    },
  }
}

interface FakeAgent {
  id: string
  ctx: FakeContext
  session?: { header?: { delegationDepth?: number } }
}

function makeAgent(id: string, depth: number, withSystemPrompt = true): FakeAgent {
  const services: Record<string, unknown> = {}
  if (withSystemPrompt) services.systemPrompt = createSystemPrompt()
  return { id, ctx: new FakeContext(services), session: { header: { delegationDepth: depth } } }
}

/** 插件的宿主 ctx：skills + agents + logger + 已存在 agent 列表。 */
function createHostContext(existingAgents: FakeAgent[] = []) {
  const registry = createSkillRegistry()
  const warns: string[] = []
  const context = new FakeContext({
    skills: registry,
    agents: { list: () => existingAgents },
    logger: { warn: (message: string) => warns.push(message) },
  })
  return { context, registry, warns }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 期望的 8 个 Skill 名（与 domain 声明一致）。 */
const EXPECTED_NAMES = DEV_DOMAIN.skills.map((skill) => skill.name)

beforeEach(() => {
  vi.clearAllMocks()
})

/* ------------------------------------------------------------------ *
 * 1. Skill 注册契约
 * ------------------------------------------------------------------ */

describe('领域 Skill 注册', () => {
  it('恰好注册 8 次，参数全部合规（runtime / directory / 正文不含 frontmatter）', () => {
    const { context, registry } = createHostContext()
    apply(context)

    expect(registry.registered).toEqual(EXPECTED_NAMES)
    expect(registry.definitions.size).toBe(8)

    for (const [name, registration] of registry.definitions) {
      const path = registration.path as string
      expect(registration.name).toBe(name)
      expect(registration.source).toBe('runtime')
      expect(registration.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(path.startsWith('/')).toBe(true)
      expect(path.endsWith(`${name}/SKILL.md`)).toBe(true)
      expect(registration.resourceBase).toEqual({ kind: 'directory', path: dirname(path) })
      expect(registration.content.startsWith('---')).toBe(false)
      expect((registration.content as string).trim().length).toBeGreaterThan(0)
      expect((registration.description as string).trim().length).toBeGreaterThan(0)
      expect((registration.whenToUse as string).trim().length).toBeGreaterThan(0)
    }
  })

  it('ctx.skills 缺失时降级：只 warn，不抛错，不注册任何 Skill', () => {
    const warns: string[] = []
    const context = new FakeContext({
      logger: { warn: (message: string) => warns.push(message) },
    })

    expect(() => apply(context)).not.toThrow()
    expect(warns.some((line) => line.includes('ctx.skills'))).toBe(true)
    // 数量取自真实声明（EXPECTED_NAMES 就是 DEV_DOMAIN.skills），文案漂移会立刻红。
    expect(warns.some((line) => line.includes(`${EXPECTED_NAMES.length} 个`))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 2. Leader persona 生命周期
 * ------------------------------------------------------------------ */

describe('Leader persona 注入', () => {
  it('depth 0 根 agent → 注入 Leader persona（槽位与正文正确）', async () => {
    const { context } = createHostContext()
    apply(context)

    const agent = makeAgent('root', 0)
    await context.emit('agent/created', { agent, source: 'test' })

    expect(agent.ctx.injectCalls).toEqual([['systemPrompt']])
    const sections = (agent.ctx.get('systemPrompt') as ReturnType<typeof createSystemPrompt>).sections
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({
      name: 'deployment:persona-prefix',
      order: 100,
      text: LEADER_PERSONA,
    })
  })

  it('depth 1 子 agent → 不注入，不调用 inject', async () => {
    const { context } = createHostContext()
    apply(context)

    const agent = makeAgent('child', 1)
    await context.emit('agent/created', { agent, source: 'subagent' })

    expect(agent.ctx.injectCalls).toEqual([])
    expect((agent.ctx.get('systemPrompt') as ReturnType<typeof createSystemPrompt>).sections).toEqual([])
  })

  it('同一 agent 重复 agent/created → 幂等，只注入一次', async () => {
    const { context } = createHostContext()
    apply(context)

    const agent = makeAgent('root', 0)
    await context.emit('agent/created', { agent, source: 'test' })
    await context.emit('agent/created', { agent, source: 'test' })
    await context.emit('agent/created', { agent, source: 'test' })

    expect(agent.ctx.injectCalls).toHaveLength(1)
    expect((agent.ctx.get('systemPrompt') as ReturnType<typeof createSystemPrompt>).sections).toHaveLength(1)
  })

  it('agent/disposed → 记录的 fiber 被 dispose，section 被释放', async () => {
    const { context } = createHostContext()
    apply(context)

    const agent = makeAgent('root', 0)
    await context.emit('agent/created', { agent, source: 'test' })
    const prompt = agent.ctx.get('systemPrompt') as ReturnType<typeof createSystemPrompt>
    expect(prompt.sections[0].disposed).toBe(false)

    await context.emit('agent/disposed', { agent })
    await flush()

    expect(agent.ctx.injectFibers[0].disposed).toBe(true)
    expect(prompt.sections[0].disposed).toBe(true)
  })

  it('systemPrompt 缺失 → 只 warn，8 个 Skill 仍注册成功', async () => {
    const { context, registry, warns } = createHostContext()
    apply(context)

    const agent = makeAgent('root', 0, false)
    await expect(context.emit('agent/created', { agent, source: 'test' })).resolves.toBeUndefined()

    expect(agent.ctx.injectCalls).toEqual([])
    expect(warns.some((line) => line.includes('systemPrompt'))).toBe(true)
    expect(registry.definitions.size).toBe(8)
  })
})

/* ------------------------------------------------------------------ *
 * 3. 卸载
 * ------------------------------------------------------------------ */

describe('插件卸载', () => {
  it('dispose 技能 effect → 8 个 unregister 全部调用，顺序为 LIFO', async () => {
    const { context, registry } = createHostContext()
    apply(context)
    expect(registry.unregistered).toEqual([])

    const skillsEffect = context.effects.find((item) => item.label === 'dev-domain:register-skills')
    expect(skillsEffect).toBeDefined()
    await (skillsEffect as { fiber: FakeFiber }).fiber.dispose()

    expect(registry.unregistered).toEqual([...registry.registered].reverse())
    expect(registry.unregistered).toHaveLength(8)
    expect(registry.definitions.size).toBe(0)
  })

  it('卸载生命周期 effect → 解绑事件并释放残留 persona fiber', async () => {
    const { context } = createHostContext()
    apply(context)

    const agent = makeAgent('root', 0)
    await context.emit('agent/created', { agent, source: 'test' })
    expect(context.listenerCount('agent/created')).toBe(1)

    const lifecycle = context.effects.find(
      (item) => item.label === 'dev-domain:leader-persona-lifecycle',
    )
    await (lifecycle as { fiber: FakeFiber }).fiber.dispose()

    expect(context.listenerCount('agent/created')).toBe(0)
    expect(context.listenerCount('agent/disposed')).toBe(0)
    expect(agent.ctx.injectFibers[0].disposed).toBe(true)
  })

  it('卸载后再装配 → 8 个 Skill 可重新注册（占位已释放）', async () => {
    const { context, registry } = createHostContext()
    apply(context)
    const skillsEffect = context.effects.find((item) => item.label === 'dev-domain:register-skills')
    await (skillsEffect as { fiber: FakeFiber }).fiber.dispose()
    expect(registry.definitions.size).toBe(0)
    expect(registry.unregistered).toHaveLength(8)

    apply(context)
    expect(registry.registered).toHaveLength(16)
    expect(registry.definitions.size).toBe(8)
  })
})

/* ------------------------------------------------------------------ *
 * 4. 只读：注册路径不得写盘
 * ------------------------------------------------------------------ */

describe('注册只读', () => {
  it('装配 + 注册 + 注入 + 卸载全程 0 次写盘调用', async () => {
    const { context } = createHostContext()
    apply(context)

    const root = makeAgent('root', 0)
    const child = makeAgent('child', 1)
    await context.emit('agent/created', { agent: root, source: 'test' })
    await context.emit('agent/created', { agent: child, source: 'subagent' })
    await context.emit('agent/disposed', { agent: root })
    await flush()

    const lifecycle = context.effects.find(
      (item) => item.label === 'dev-domain:leader-persona-lifecycle',
    )
    await (lifecycle as { fiber: FakeFiber }).fiber.dispose()
    await context.effects[0].fiber.dispose()

    const writeApis = [
      'writeFileSync',
      'writeFile',
      'appendFileSync',
      'appendFile',
      'mkdirSync',
      'mkdir',
      'rmSync',
      'rm',
      'unlinkSync',
      'unlink',
      'renameSync',
      'rename',
      'copyFileSync',
      'copyFile',
      'truncateSync',
      'createWriteStream',
    ] as const

    for (const api of writeApis) {
      const spy = (fs as unknown as Record<string, { mock?: { calls: unknown[] } }>)[api]
      expect(spy?.mock, `${api} 未被 spy 包裹`).toBeDefined()
      expect(spy?.mock?.calls.length, `${api} 被调用了`).toBe(0)
    }
  })
})
