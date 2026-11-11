/**
 * 固件 Skill 的**纯逻辑**契约：frontmatter 解析、注册参数构造、重名 / 非法名
 * 校验、注册失败原子回滚。
 *
 * 原文件里的真实 core 集成用例已随任务-05 删除：装配与会话
 * 行为改由 `tests/plugin.spec.ts` 用 fake ctx 覆盖，这里只保留不依赖运行时的
 * 可判定断言。
 */
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEV_DOMAIN } from '../src/domain'
import {
  buildFirmwareSkillRegistration,
  parseFirmwareSkillMarkdown,
  planFirmwareSkillRegistrations,
  type FirmwareSkill,
} from '../src/firmware'
import { registerDomainFirmwareSkills } from '../src/plugin'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 记录 warn 的 logger。 */
function recordingLogger(): { logger: { warn: (message: string) => void }; warns: string[] } {
  const warns: string[] = []
  return { logger: { warn: (message: string) => void warns.push(message) }, warns }
}

/** 只有 `skills` 服务的假 ctx（`reflect.get` 是非严格探测入口）。 */
function fakeContext(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
    reflect: { get: (name: string) => services[name] },
  } as unknown as Context
}

/** 内存版 skills 注册表：记录注册 / 反注册顺序。 */
function memoryRegistry(options: { failAt?: number } = {}) {
  const live = new Set<string>()
  const unregistered: string[] = []
  let calls = 0
  return {
    live,
    unregistered,
    register(registration: { name: string }) {
      calls += 1
      if (options.failAt === calls) throw new Error('boom')
      live.add(registration.name)
      return () => {
        unregistered.push(registration.name)
        live.delete(registration.name)
      }
    },
  }
}

/** 构造一个 frontmatter 完整的临时 Skill。 */
function sample(name: string): FirmwareSkill {
  return {
    name,
    markdown: ['---', `name: ${name}`, 'description: 描述', 'whenToUse: 何时使用', '---', '# 正文'].join('\n'),
  }
}

const SKILL_NAMES = DEV_DOMAIN.skills.map((skill) => skill.name)

/* ------------------------------------------------------------------ *
 * 1. frontmatter 解析
 * ------------------------------------------------------------------ */

describe('parseFirmwareSkillMarkdown', () => {
  it('解析三字段并剥离 frontmatter（正文不含元数据）', () => {
    const markdown = [
      '---',
      'name: demo-skill',
      'description: 一句话说明',
      'whenToUse: 什么时候用',
      '---',
      '',
      '# 正文',
      '',
      '细节。',
    ].join('\n')

    const parsed = parseFirmwareSkillMarkdown(markdown, 'demo')
    expect(parsed.name).toBe('demo-skill')
    expect(parsed.description).toBe('一句话说明')
    expect(parsed.whenToUse).toBe('什么时候用')
    expect(parsed.content.startsWith('---')).toBe(false)
    expect(parsed.content).not.toContain('whenToUse')
    expect(parsed.content.trimStart().startsWith('# 正文')).toBe(true)
  })

  it('支持成对引号与 CRLF', () => {
    const markdown = [
      '---',
      'name: "quoted-skill"',
      "description: '单引号描述'",
      'whenToUse: 用',
      '---',
      '正文',
    ].join('\r\n')

    const parsed = parseFirmwareSkillMarkdown(markdown, 'quoted')
    expect(parsed.name).toBe('quoted-skill')
    expect(parsed.description).toBe('单引号描述')
  })

  it('缺 frontmatter → 抛错并点名来源', () => {
    expect(() => parseFirmwareSkillMarkdown('# 没有 frontmatter', 'demo')).toThrowError(
      /demo[\s\S]*frontmatter/,
    )
  })

  it.each(['name', 'description', 'whenToUse'])('缺字段 %s → 抛错并点名字段', (field) => {
    const lines = ['---']
    if (field !== 'name') lines.push('name: demo')
    if (field !== 'description') lines.push('description: 描述')
    if (field !== 'whenToUse') lines.push('whenToUse: 用')
    lines.push('---', '正文')

    expect(() => parseFirmwareSkillMarkdown(lines.join('\n'), 'demo')).toThrowError(
      new RegExp(field),
    )
  })
})

/* ------------------------------------------------------------------ *
 * 2. 注册参数构造
 * ------------------------------------------------------------------ */

describe('buildFirmwareSkillRegistration', () => {
  it('9 个领域 Skill 的注册参数全部合规', () => {
    expect(DEV_DOMAIN.skills).toHaveLength(9)

    for (const skill of DEV_DOMAIN.skills) {
      const registration = buildFirmwareSkillRegistration(skill)

      expect(registration.name).toBe(skill.name)
      expect(registration.source).toBe('runtime')
      expect(registration.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect((registration.description as string).length).toBeGreaterThan(0)
      expect((registration.whenToUse as string).length).toBeGreaterThan(0)

      const path = registration.path as string
      expect(path.startsWith('/')).toBe(true)
      expect(path.endsWith(join('skills', skill.name, 'SKILL.md'))).toBe(true)
      expect(registration.resourceBase).toEqual({ kind: 'directory', path: dirname(path) })

      // 模型可见正文不含 frontmatter。
      expect(registration.content.startsWith('---')).toBe(false)
      expect(registration.content).not.toContain(`name: ${skill.name}`)
      expect(registration.content).not.toContain('whenToUse:')
      expect((registration.content as string).trim().length).toBeGreaterThan(0)
    }
  })

  it('声明名与 frontmatter.name 不一致（非法声明）→ 抛错且消息含两者', () => {
    const broken: FirmwareSkill = {
      name: 'declared-name',
      markdown: sample('frontmatter-name').markdown,
    }
    expect(() => buildFirmwareSkillRegistration(broken)).toThrowError(/declared-name/)
    expect(() => buildFirmwareSkillRegistration(broken)).toThrowError(/frontmatter-name/)
  })

  it('声明侧 description 可覆盖 frontmatter.description', () => {
    const registration = buildFirmwareSkillRegistration({
      ...sample('override-skill'),
      description: '声明侧描述',
    })
    expect(registration.description).toBe('声明侧描述')
  })
})

/* ------------------------------------------------------------------ *
 * 3. 注册计划查重
 * ------------------------------------------------------------------ */

describe('planFirmwareSkillRegistrations', () => {
  it('声明内重名只注册一次，其余记为 duplicate-declaration', () => {
    const plan = planFirmwareSkillRegistrations([sample('a-skill'), sample('a-skill')])
    expect(plan.registrations.map((item) => item.name)).toEqual(['a-skill'])
    expect(plan.skipped).toEqual([{ name: 'a-skill', reason: 'duplicate-declaration' }])
  })

  it('skip 回调命中 → 跳过并记为 already-registered', () => {
    const plan = planFirmwareSkillRegistrations([sample('a-skill'), sample('b-skill')], {
      skip: (name) => name === 'b-skill',
    })
    expect(plan.registrations.map((item) => item.name)).toEqual(['a-skill'])
    expect(plan.skipped).toEqual([{ name: 'b-skill', reason: 'already-registered' }])
  })

  it('9 个领域 Skill 全部进入计划，无跳过', () => {
    const plan = planFirmwareSkillRegistrations(DEV_DOMAIN.skills)
    expect(plan.registrations.map((item) => item.name)).toEqual(SKILL_NAMES)
    expect(plan.skipped).toEqual([])
  })

  it('空声明 → 空计划（不抛错）', () => {
    expect(planFirmwareSkillRegistrations(undefined)).toEqual({ registrations: [], skipped: [] })
    expect(planFirmwareSkillRegistrations([])).toEqual({ registrations: [], skipped: [] })
  })
})

/* ------------------------------------------------------------------ *
 * 4. 注册 / 原子回滚 / 幂等
 * ------------------------------------------------------------------ */

describe('registerDomainFirmwareSkills', () => {
  it('注册 9 个 Skill，返回等长 unregister 数组', () => {
    const registry = memoryRegistry()
    const { logger, warns } = recordingLogger()

    const unregisters = registerDomainFirmwareSkills(
      fakeContext({ skills: registry }),
      DEV_DOMAIN.skills,
      logger,
    )

    expect(unregisters).toHaveLength(9)
    expect([...registry.live].sort()).toEqual([...SKILL_NAMES].sort())
    expect(warns).toEqual([])
  })

  it('第 2 个注册抛错 → 已注册项被原子回滚，错误信息点出回滚项', () => {
    const registry = memoryRegistry({ failAt: 2 })
    const { logger } = recordingLogger()

    let error: unknown
    try {
      registerDomainFirmwareSkills(fakeContext({ skills: registry }), DEV_DOMAIN.skills, logger)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('已回滚')
    expect((error as Error).message).toContain('dev-container')
    expect((error as Error).message).toContain('boom')
    // 只回滚了第 1 个，注册表回到空态。
    expect(registry.unregistered).toEqual(['dev-container'])
    expect(registry.live.size).toBe(0)
  })

  it('同一 ctx 第二次调用 → 全部跳过并 warn，注册表不变', () => {
    const registry = memoryRegistry()
    const { logger, warns } = recordingLogger()
    const ctx = fakeContext({ skills: registry })

    expect(registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)).toHaveLength(9)
    expect(registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)).toHaveLength(0)

    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('跳过 9 个')
    expect(warns[0]).toContain('dev-container')
    expect(registry.live.size).toBe(9)
  })

  it('反注册后占位释放 → 可以重新注册（卸载再装路径）', () => {
    const registry = memoryRegistry()
    const { logger, warns } = recordingLogger()
    const ctx = fakeContext({ skills: registry })

    const first = registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)
    for (const unregister of [...first].reverse()) unregister()
    expect(registry.live.size).toBe(0)

    expect(registerDomainFirmwareSkills(ctx, DEV_DOMAIN.skills, logger)).toHaveLength(9)
    expect(registry.live.size).toBe(9)
    expect(warns).toEqual([])
  })

  it('ctx.skills 缺失 → 降级返回空数组，只 warn 不抛', () => {
    const { logger, warns } = recordingLogger()

    expect(registerDomainFirmwareSkills(fakeContext({}), DEV_DOMAIN.skills, logger)).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('ctx.skills')
    // 数量与声明同源（动态插值），加删 Skill 时文案与断言一起变，不会静默漂移。
    expect(warns[0]).toContain(`${DEV_DOMAIN.skills.length} 个`)
  })

  it('register() 返回非函数 → 视为失败并回滚', () => {
    const { logger } = recordingLogger()
    const registry = {
      register() {
        return undefined as unknown as () => void
      },
    }

    expect(() =>
      registerDomainFirmwareSkills(
        fakeContext({ skills: registry }),
        [sample('only-skill')],
        logger,
      ),
    ).toThrowError(/未返回 unregister/)
  })
})
