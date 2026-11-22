import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { createStagingAsset, runAsset, settleStagingAsset } from '../src/asset'
import { apply, buildAssetTool } from '../src/tools/asset'

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function writeYaml(file: string, value: unknown): void {
  write(file, stringifyYaml(value))
}

function execStub(agent: object = {}): any {
  return { agent, signal: new AbortController().signal }
}

describe('asset advanced', () => {
  let root: string
  let projectRoot: string
  let stateRoot: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'asset-advanced-'))
    projectRoot = path.join(root, 'project')
    stateRoot = path.join(root, 'state')
    mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('L3 scaffold defaults to failed and does not fake a pass', () => {
    const created = createStagingAsset({ projectRoot, taskId: 't1', name: 'todo', purpose: 'x' })
    const script = readFileSync(path.join(created.stagingPath, 'run.mjs'), 'utf8')
    expect(script).toContain("status: 'failed'")
    expect(script).toContain('TODO: implement asset logic')
  })

  it('rejects passed results with empty assertions', async () => {
    write(path.join(projectRoot, '.agent/assets/packs/empty/run.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ status: 'passed', assertions: [] }))",
      '',
    ].join('\n'))
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'empty', layer: 'L2', entry: 'packs/empty/run.mjs', last_verified: '2026-11-22' }],
    })
    write(path.join(projectRoot, 'scenario.json'), '{}')
    const result = await runAsset({ projectRoot, id: 'empty', scenario: 'scenario.json' })
    expect(result.status).toBe('failed')
    expect(result.diagnosis?.code).toBe('EMPTY_ASSERTIONS')
  })

  it('defaults to propose-l2 and rejects promote-l2 without allowRepoWrite', () => {
    createStagingAsset({ projectRoot, taskId: 't1', name: 'candidate', purpose: 'x' })
    const proposed = settleStagingAsset({ projectRoot, name: 'candidate', decision: 'propose-l2' })
    expect(proposed.status).toBe('propose-l2')
    expect(existsSync(path.join(projectRoot, '.agent/assets/promotions/candidate/promotion.yaml'))).toBe(true)
    expect(existsSync(path.join(projectRoot, '.agent/assets/packs/candidate'))).toBe(false)

    createStagingAsset({ projectRoot, taskId: 't2', name: 'blocked', purpose: 'x' })
    expect(() => settleStagingAsset({ projectRoot, name: 'blocked', decision: 'promote-l2' })).toThrow(/allowRepoWrite/)
  })

  it('accepts scenarios under scenario_root outside project_root', async () => {
    write(path.join(projectRoot, '.agent/assets/packs/echo/run.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const i = process.argv.indexOf('--scenario')",
      "const scenario = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'))",
      "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ status: 'passed', assertions: [{ passed: true }], value: scenario.value }))",
      '',
    ].join('\n'))
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'echo', layer: 'L2', entry: 'packs/echo/run.mjs', last_verified: '2026-11-22' }],
    })
    const verifyRoot = path.join(root, 'verify')
    write(path.join(verifyRoot, 'scenario.json'), JSON.stringify({ value: 1 }))
    const scenario = path.join(verifyRoot, 'scenario.json')
    await expect(runAsset({ projectRoot, id: 'echo', scenario })).rejects.toThrow(/场景文件越界/)
    const result = await runAsset({ projectRoot, id: 'echo', scenario, scenarioRoot: verifyRoot })
    expect(result.status).toBe('passed')
  })

  it('blocks non-asset tools while staging is pending, then allows after finalize', async () => {
    let listener: any
    const registered: any[] = []
    const ctx = {
      on: (_event: string, fn: any) => {
        listener = fn
      },
      tools: {
        register: (tool: any) => {
          registered.push(tool)
          return () => {}
        },
      },
    }
    apply(ctx as never, { projectRoot, stateRoot })
    const tool = registered[0]
    const agent = {}
    const created = await tool.execute({ action: 'create', task_id: 't1', name: 'pending', purpose: 'x', project_root: projectRoot }, execStub(agent))
    expect(created.ok).toBe(true)

    const denied = await listener({ name: 'bash', agent }, async () => ({ kind: 'enter' }))
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('staging 未结算')

    const settled = await tool.execute({ action: 'settle', task_id: 't1', id: 'pending', decision: 'discard', project_root: projectRoot }, execStub(agent))
    expect(settled.ok).toBe(true)

    const finalized = await tool.execute({ action: 'finalize', task_id: 't1', project_root: projectRoot }, execStub(agent))
    expect(finalized.ok).toBe(true)
    expect(finalized.data.asset_block).toContain('## 资产')
    expect(finalized.data.asset_block).toContain('staging: settled')

    const allowed = await listener({ name: 'bash', agent }, async () => ({ kind: 'enter' }))
    expect(allowed.kind).toBe('enter')
  })

  it('writes usage.jsonl and trust.json after a run', async () => {
    write(path.join(projectRoot, '.agent/assets/packs/echo/run.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ status: 'passed', assertions: [{ passed: true }] }))",
      '',
    ].join('\n'))
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'echo', layer: 'L2', entry: 'packs/echo/run.mjs', last_verified: '2026-11-22' }],
    })
    write(path.join(projectRoot, 'scenario.json'), '{}')
    const tool = buildAssetTool({ projectRoot, stateRoot })
    const result = await tool.execute({ action: 'run', task_id: 't1', id: 'echo', scenario: 'scenario.json', project_root: projectRoot }, execStub()) as any
    expect(result.ok).toBe(true)
    expect(existsSync(path.join(stateRoot, 'metrics/usage.jsonl'))).toBe(true)
    expect(existsSync(path.join(stateRoot, 'trust.json'))).toBe(true)
    expect(readFileSync(path.join(stateRoot, 'metrics/usage.jsonl'), 'utf8')).toContain('echo')
  })

  it('enforces per-task create budget', async () => {
    const tool = buildAssetTool({ projectRoot, stateRoot, maxCreatesPerTask: 1 })
    const first = await tool.execute({ action: 'create', task_id: 't1', name: 'one', purpose: 'x', project_root: projectRoot }, execStub()) as any
    expect(first.ok).toBe(true)
    const second = await tool.execute({ action: 'create', task_id: 't1', name: 'two', purpose: 'x', project_root: projectRoot }, execStub()) as any
    expect(second.ok).toBe(false)
    expect(second.error.code).toBe('BUDGET_EXCEEDED')
  })
})
