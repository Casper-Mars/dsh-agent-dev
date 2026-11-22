import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildAssetTool } from '../src/tools/asset'

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function writeYaml(file: string, value: unknown): void {
  write(file, stringifyYaml(value))
}

function execStub(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

describe('asset tool', () => {
  let root: string
  let projectRoot: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'asset-tool-'))
    projectRoot = path.join(root, 'project')
    mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('searches registered assets by tags', async () => {
    write(path.join(projectRoot, '.agent/assets/packs/web/run.mjs'), '// web')
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'web/runner', layer: 'L2', entry: 'packs/web/run.mjs', tags: ['web', 'ui'], last_verified: '2026-11-20' }],
    })
    const tool = buildAssetTool({ projectRoot })
    const result = await tool.execute({ action: 'search', tags: ['web'] }, execStub()) as any
    expect(result.ok).toBe(true)
    expect(result.action).toBe('search')
    expect(result.data.items).toHaveLength(1)
    expect(result.data.items[0]).toMatchObject({ id: 'web/runner', layer: 'L2', source: 'project', health: 'ok' })
  })

  it('creates staging and settles to L2', async () => {
    const tool = buildAssetTool({ projectRoot })
    const created = await tool.execute({
      action: 'create',
      task_id: 't1',
      name: 'verify-drawer',
      purpose: '验证抽屉',
      reuse_expect: 4,
    }, execStub()) as any
    expect(created.ok).toBe(true)
    expect(created.data.staging_path).toContain('staging/t1/verify-drawer')

    const settled = await tool.execute({
      action: 'settle',
      id: 'verify-drawer',
      decision: 'promote-l2',
      owner: 'tester',
    }, execStub()) as any
    expect(settled.ok).toBe(true)
    expect(settled.data.registry_updated).toBe(true)
    const registry = readFileSync(path.join(projectRoot, '.agent/assets/registry.yaml'), 'utf8')
    expect(registry).toContain('verify-drawer')
    expect(registry).toContain('layer: L2')
  })

  it('runs an asset and reports structured facts', async () => {
    write(path.join(projectRoot, '.agent/assets/packs/echo/run.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const i = process.argv.indexOf('--scenario')",
      "const scenario = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'))",
      "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ status: 'passed', value: scenario.value, artifacts: ['shot.png'] }))",
      '',
    ].join('\n'))
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'echo', layer: 'L2', entry: 'packs/echo/run.mjs', last_verified: '2026-11-20' }],
    })
    write(path.join(projectRoot, 'scenario.json'), JSON.stringify({ value: 7 }))
    const tool = buildAssetTool({ projectRoot })
    const result = await tool.execute({ action: 'run', id: 'echo', scenario: 'scenario.json', timeout_ms: 5_000 }, execStub()) as any
    expect(result.ok).toBe(true)
    expect(result.data.status).toBe('passed')
    expect(result.data.artifacts).toEqual(['shot.png'])
  })

  it('requires project_root instead of falling back to session cwd', async () => {
    const tool = buildAssetTool()
    const result = await tool.execute({ action: 'search', tags: ['web'] }, execStub()) as any
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('INVALID_MANIFEST')
    expect(result.error.message).toContain('project_root 必填')
  })

  it('returns structured errors instead of throwing', async () => {
    const tool = buildAssetTool({ projectRoot })
    const missing = await tool.execute({ action: 'run', id: 'no-such', scenario: 'scenario.json' }, execStub()) as any
    expect(missing.ok).toBe(false)
    expect(missing.error.code).toBe('ASSET_NOT_FOUND')

    await expect(tool.execute({ action: 'bogus' } as any, execStub())).rejects.toThrow(/must be one of/)
  })

  it('registers exactly one tool named asset', async () => {
    const registered: string[] = []
    const ctx = {
      tools: {
        register: (tool: { name: string }) => {
          registered.push(tool.name)
          return () => {}
        },
      },
    }
    const { apply } = await import('../src/tools/asset')
    apply(ctx as never, { projectRoot })
    expect(registered).toEqual(['asset'])
  })
})
