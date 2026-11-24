/**
 * `cordis.patch.yml` 契约（任务-04）。
 *
 * patch 是安装期的**唯一装配入口**：领域插件、3 个 agent preset、主会话默认
 * preset 与子 agent 兜底都写在这里。本文件用真实 YAML 解析断言结构，
 * 避免正则误判注释。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const SOURCE = readFileSync(PATCH_FILE, 'utf8')

interface PatchPlugin {
  id: string
  name: string
  config?: Record<string, unknown>
}

interface PatchEntry {
  insert?: PatchPlugin[]
  id?: string
  config?: Record<string, unknown>
}

const PATCH = parse(SOURCE) as PatchEntry[]

/** 第一个 patch 条目里的全部 insert 项。 */
const INSERTED: PatchPlugin[] = PATCH.flatMap((entry) => entry.insert ?? [])

/** 顶层（非 insert）的补丁条目，如 `- id: tool-subagent`。 */
const TOP_LEVEL: PatchEntry[] = PATCH.filter((entry) => entry.insert === undefined)

const byId = (id: string): PatchPlugin => {
  const found = INSERTED.find((item) => item.id === id)
  expect(found, `cordis.patch.yml 缺少 insert 项 "${id}"`).toBeDefined()
  return found as PatchPlugin
}

/** preset 的 plugin 名列表。 */
const presetPluginNames = (id: string): string[] => {
  const config = byId(id).config as { plugins?: Array<{ name: string }> }
  return (config.plugins ?? []).map((plugin) => plugin.name)
}

describe('cordis.patch.yml 卫生', () => {
  it('全文不再出现 rsi-agent，也没有 complete: true', () => {
    expect(SOURCE).not.toContain('rsi-agent')
    expect(SOURCE).not.toMatch(/complete\s*:\s*true/)
  })

  it('解析后任何 preset 的 config 都不含 complete 字段', () => {
    for (const plugin of INSERTED) {
      if (plugin.name !== '@deepseek-ai/dsh-agent-preset') continue
      expect(plugin.config).toBeDefined()
      expect(Object.hasOwn(plugin.config as object, 'complete')).toBe(false)
    }
  })

  it('恰好 3 个 agent preset，id 为 dev-leader / dev-developer / dev-tester', () => {
    const presets = INSERTED.filter((item) => item.name === '@deepseek-ai/dsh-agent-preset')
    expect(presets.map((item) => (item.config as { id: string }).id)).toEqual([
      'dev-leader',
      'dev-developer',
      'dev-tester',
    ])
  })
})

describe('领域插件条目', () => {
  it('dev-domain 的 name / inject 与 src/plugin.ts 一致', () => {
    const entry = byId('dev-domain')
    expect(entry.name).toBe('dsh-agent-dev')
    expect(entry.config).toBeUndefined()
    expect((entry as unknown as { inject?: string[] }).inject).toEqual(['agents'])
  })
})

describe('主会话 preset（dev-leader）', () => {
  it('挂载 subagent 控制面（dsh 0.2.2 起 list_agents 由 control 主入口注册），但不挂 persona', () => {
    const names = presetPluginNames('preset-dev-leader')
    expect(names).toContain('@deepseek-ai/dsh-tool-subagent-control')
    expect(names).not.toContain('@deepseek-ai/dsh-tool-subagent-control/list-agents')
    expect(names).not.toContain('@deepseek-ai/dsh-persona')
  })

  it('内层 tool-subagent 兜底为只读的 dev-tester，限深 1', () => {
    const config = byId('preset-dev-leader').config as {
      plugins: Array<{ id: string; config?: Record<string, unknown> }>
    }
    const subagent = config.plugins.find((plugin) => plugin.id === 'tool-subagent')
    expect(subagent).toBeDefined()
    expect(subagent?.config).toMatchObject({
      agentPreset: 'dev-tester',
      allowedAgentPresets: ['dev-developer', 'dev-tester'],
      maxDepth: 1,
    })
  })
})

describe('主会话工具面扩展', () => {
  it('dev-leader 不挂 schedule / plan-mode / workflow（schema 是每步固定开销）', () => {
    const config = byId('preset-dev-leader').config as {
      plugins: Array<{ id: string }>
    }
    const ids = config.plugins.map((plugin) => plugin.id)
    expect(ids).toContain('tool-jobs')
    expect(ids).not.toContain('tool-schedule')
    expect(ids).not.toContain('planning')
    expect(ids).not.toContain('workflow')
  })

  it('dev-leader 挂浏览器工具：页面取证走 browser_*，不用手搓脚本', () => {
    const config = byId('preset-dev-leader').config as {
      plugins: Array<{ id: string; name: string; config?: Record<string, unknown> }>
    }
    const browser = config.plugins.find((plugin) => plugin.name === 'dsh-browser-native')
    expect(browser, 'dev-leader 缺少 dsh-browser-native').toBeDefined()
    expect(browser?.config).toEqual({ screenshotDir: '.shots' })
  })

  it('子 agent preset 不挂 schedule / plan-mode / workflow（编排留在 Leader）', () => {
    for (const id of ['preset-dev-developer', 'preset-dev-tester']) {
      const config = byId(id).config as { plugins: Array<{ id: string }> }
      const ids = config.plugins.map((plugin) => plugin.id)
      expect(ids).toContain('tool-jobs')
      expect(ids).not.toContain('tool-schedule')
      expect(ids).not.toContain('planning')
      expect(ids).not.toContain('workflow')
    }
  })
})

describe('子 agent preset', () => {
  it.each(['preset-dev-developer', 'preset-dev-tester'])('%s 自带 persona', (id) => {
    expect(presetPluginNames(id)).toContain('@deepseek-ai/dsh-persona')
  })

  it('Developer 与 Tester 的 persona 前缀非空且不互相串味', () => {
    const prefixOf = (id: string): string => {
      const config = byId(id).config as {
        plugins: Array<{ id: string; name: string; config?: { prefix?: string } }>
      }
      const persona = config.plugins.find((plugin) => plugin.name === '@deepseek-ai/dsh-persona')
      return persona?.config?.prefix ?? ''
    }

    expect(prefixOf('preset-dev-developer')).toContain('Developer')
    expect(prefixOf('preset-dev-tester')).toContain('Tester')
  })
})

describe('Developer PTC 呈现', () => {
  it('dev-developer 挂 tool-presentation，模式为 ptc', () => {
    const config = byId('preset-dev-developer').config as {
      plugins: Array<{ id: string; name: string; config?: Record<string, unknown> }>
    }
    const row = config.plugins.find((plugin) => plugin.id === 'tool-presentation')
    expect(row).toBeDefined()
    expect(row?.name).toBe('@deepseek-ai/dsh-agent-tool-presentation')
    expect(row?.config).toEqual({ mode: 'ptc' })
  })

  it('dev-leader / dev-tester 保持 native，不挂 tool-presentation', () => {
    for (const id of ['preset-dev-leader', 'preset-dev-tester']) {
      const config = byId(id).config as { plugins: Array<{ id: string }> }
      expect(config.plugins.some((plugin) => plugin.id === 'tool-presentation')).toBe(false)
    }
  })
})

describe('preset 路由', () => {
  it('agent-preset-registry.default 是 dev-leader（主会话路径）', () => {
    const config = byId('agent-preset-registry').config as { default?: string }
    expect(config.default).toBe('dev-leader')
  })

  it('顶层 tool-subagent.agentPreset 是 dev-tester（子 agent 兜底路径）', () => {
    const entry = TOP_LEVEL.find((item) => item.id === 'tool-subagent')
    expect(entry).toBeDefined()
    expect(entry?.config).toMatchObject({
      agentPreset: 'dev-tester',
      allowedAgentPresets: ['dev-developer', 'dev-tester'],
      maxDepth: 1,
    })
  })
})

describe('工具面 preset 化', () => {
  it('dev-leader 挂 echuan leader + core task-readonly', () => {
    const names = presetPluginNames('preset-dev-leader')
    expect(names).toContain('dsh-echuan/tools/leader')
    expect(names).toContain('dsh-agent-base/tools/task-readonly')
  })

  it('dev-developer / dev-tester 只挂 echuan readonly，且不挂任何 core task-*', () => {
    for (const id of ['preset-dev-developer', 'preset-dev-tester']) {
      const names = presetPluginNames(id)
      expect(names).toContain('dsh-echuan/tools/readonly')
      expect(names.filter(name => name.startsWith('dsh-echuan/'))).toEqual(['dsh-echuan/tools/readonly'])
      expect(names.some(name => name.startsWith('dsh-agent-base/tools/task-'))).toBe(false)
    }
  })
})
