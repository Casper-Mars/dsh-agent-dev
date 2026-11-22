import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildAssetTool } from '../src/tools/asset'
import { DEVELOPER_SKILLS, LEADER_SKILLS, TESTER_SKILLS } from '../src/assets'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8')
}

describe('asset tool contract', () => {
  it('is exported as a package subpath', () => {
    const pkg = JSON.parse(read('package.json')) as { exports: Record<string, unknown> }
    expect(pkg.exports['./tools/asset']).toBeDefined()
  })

  it('is mounted in all three dev presets', () => {
    const patch = read('cordis.patch.yml')
    expect(patch.match(/id: tool-asset/g)).toHaveLength(3)
    expect(patch.match(/name: dsh-agent-dev\/tools\/asset/g)).toHaveLength(3)
  })

  it('asset-first is visible in all three presets', () => {
    expect(LEADER_SKILLS).toContain('asset-first')
    expect(DEVELOPER_SKILLS).toContain('asset-first')
    expect(TESTER_SKILLS).toContain('asset-first')
    const patch = read('cordis.patch.yml')
    expect(patch.match(/asset 工具 search/g)).toHaveLength(2)
  })

  it('pins the dispatch card and delivery report contract', () => {
    const dispatch = read('skills/dev-dispatch-contract/SKILL.md')
    expect(dispatch).toContain('资产：`asset` 工具 `search` 命中的 id')
    expect(dispatch).toContain('已先调用 `asset` 工具 `search`')
    expect(dispatch).not.toMatch(/^13\./m)

    const gate = read('skills/dev-quality-gate/SKILL.md')
    expect(gate).toContain('## 资产')
    expect(gate).toContain('staging 已 settle')

    const leader = read('src/persona/LEADER.md')
    expect(leader).toContain('staging 已 settle')
    expect(leader).toContain('`## 资产`')
  })

  it('exposes the five action protocol', () => {
    const tool = buildAssetTool()
    expect(tool.name).toBe('asset')
    const parameters = tool.parameters as { properties?: Record<string, { enum?: unknown[] }> }
    const action = parameters.properties?.action as { enum?: unknown[] }
    expect(action.enum).toEqual(['search', 'create', 'run', 'settle', 'audit'])
    expect(tool.description).toContain('search')
    expect(tool.description).toContain('settle')
    expect(tool.description).toContain('不返回下一步建议')
  })
})
