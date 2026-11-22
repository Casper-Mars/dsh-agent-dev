import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import {
  AssetError,
  auditAssets,
  createStagingAsset,
  diagnoseAsset,
  loadSnapshot,
  runAsset,
  searchAssets,
  settleStagingAsset,
} from '../src/asset'

const NOW = new Date('2026-11-22T00:00:00Z')

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function writeYaml(file: string, value: unknown): void {
  write(file, stringifyYaml(value))
}

function writeRunScript(file: string, body: string): void {
  write(file, body)
}

describe('asset core', () => {
  let root: string
  let projectRoot: string
  let libraryRoot: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'asset-core-'))
    projectRoot = path.join(root, 'project')
    libraryRoot = path.join(root, 'library')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(libraryRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('merges project over library, resolves pin, and filters tags', () => {
    writeYaml(path.join(projectRoot, '.agent/assets.yaml'), { library: '0.1.0', runners: { 'web-ui': '0.1.0' } })
    write(path.join(libraryRoot, '0.1.0/runners/web-ui/run.mjs'), '// library')
    writeYaml(path.join(libraryRoot, '0.1.0/registry.yaml'), {
      version: 1,
      assets: [
        { id: 'web-ui/runner', layer: 'L1', entry: 'runners/web-ui/run.mjs', tags: ['web', 'ui'], last_verified: '2026-11-01' },
        { id: 'wait-http', layer: 'L0', entry: 'primitives/wait-http/run.sh', tags: ['http'] },
      ],
    })
    write(path.join(projectRoot, '.agent/assets/runners/web-ui/run.mjs'), '// project')
    write(path.join(projectRoot, '.agent/assets/packs/project-helper/run.mjs'), '// helper')
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [
        { id: 'web-ui/runner', layer: 'L2', entry: 'runners/web-ui/run.mjs', tags: ['web', 'ui'], last_verified: '2026-11-20' },
        { id: 'project-helper', layer: 'L2', entry: 'packs/project-helper/run.mjs', tags: ['web'], last_verified: '2026-11-20' },
      ],
    })

    const snapshot = loadSnapshot({ projectRoot, libraryRoot, now: NOW })
    expect(snapshot.libraryVersion).toBe('0.1.0')
    expect(snapshot.assets.map(asset => asset.id).sort()).toEqual(['project-helper', 'wait-http', 'web-ui/runner'])
    expect(snapshot.assets.find(asset => asset.id === 'web-ui/runner')?.source).toBe('project')
    expect(snapshot.issues.some(issue => issue.code === 'SHADOWED_ID')).toBe(true)

    expect(searchAssets(snapshot, { tags: ['web'] }).map(asset => asset.id)).toEqual(['project-helper', 'web-ui/runner'])
    expect(searchAssets(snapshot, { tags: ['http'] }).map(asset => asset.id)).toEqual(['wait-http'])
    expect(searchAssets(snapshot, { tags: ['web', 'ui'] }).map(asset => asset.id)).toEqual(['web-ui/runner'])
  })

  it('marks stale and missing entries without throwing', () => {
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [
        { id: 'stale', layer: 'L2', entry: 'packs/stale/run.mjs', last_verified: '2025-01-01' },
        { id: 'missing', layer: 'L2', entry: 'packs/missing/run.mjs', last_verified: '2026-11-20' },
      ],
    })
    write(path.join(projectRoot, '.agent/assets/packs/stale/run.mjs'), '// stale')
    const snapshot = loadSnapshot({ projectRoot, now: NOW })
    expect(snapshot.assets.find(asset => asset.id === 'stale')?.health).toBe('stale')
    expect(snapshot.assets.find(asset => asset.id === 'missing')?.health).toBe('missing')
  })

  it('rejects path escape in registry', () => {
    write(path.join(root, 'outside.mjs'), '// outside')
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'escape', layer: 'L2', entry: '../../outside.mjs' }],
    })
    const snapshot = loadSnapshot({ projectRoot, now: NOW })
    expect(snapshot.assets).toHaveLength(0)
    expect(snapshot.issues.some(issue => issue.code === 'PATH_ESCAPE')).toBe(true)
  })

  it('runs an asset and returns structured result', async () => {
    writeRunScript(path.join(projectRoot, '.agent/assets/packs/echo/run.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const i = process.argv.indexOf('--scenario')",
      "const scenario = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'))",
      "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ status: 'passed', value: scenario.value, artifacts: ['shot.png'] }))",
      "console.log(JSON.stringify({ ok: true }))",
      '',
    ].join('\n'))
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'echo', layer: 'L2', entry: 'packs/echo/run.mjs', last_verified: '2026-11-20' }],
    })
    write(path.join(projectRoot, 'scenario.json'), JSON.stringify({ value: 42 }))

    const result = await runAsset({ projectRoot, id: 'echo', scenario: 'scenario.json', timeoutMs: 5_000 })
    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
    expect(result.result).toMatchObject({ status: 'passed', value: 42 })
    expect(result.artifacts).toEqual(['shot.png'])
    expect(result.resultPath).toBe(path.join(projectRoot, '.agent/assets/packs/echo/result.json'))
  })

  it('returns timeout instead of hanging', async () => {
    writeRunScript(path.join(projectRoot, '.agent/assets/packs/slow/run.mjs'), 'setTimeout(() => {}, 5000)\n')
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [{ id: 'slow', layer: 'L2', entry: 'packs/slow/run.mjs', last_verified: '2026-11-20' }],
    })
    write(path.join(projectRoot, 'scenario.json'), '{}')
    const started = Date.now()
    const result = await runAsset({ projectRoot, id: 'slow', scenario: 'scenario.json', timeoutMs: 100 })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('creates, promotes, proposes, discards and records debt', () => {
    const created = createStagingAsset({
      projectRoot,
      taskId: 't1',
      name: 'verify-drawer',
      purpose: '验证抽屉',
      owner: 'tester',
      reuseExpect: 4,
      tags: ['ui'],
    })
    expect(existsSync(path.join(created.stagingPath, 'asset.yaml'))).toBe(true)
    expect(existsSync(path.join(created.stagingPath, 'test/smoke.sh'))).toBe(true)

    const promoted = settleStagingAsset({ projectRoot, name: 'verify-drawer', decision: 'promote-l2', owner: 'tester', allowRepoWrite: true })
    expect(promoted.registryUpdated).toBe(true)
    expect(existsSync(path.join(projectRoot, '.agent/assets/packs/verify-drawer/run.mjs'))).toBe(true)
    const registry = readFileSync(path.join(projectRoot, '.agent/assets/registry.yaml'), 'utf8')
    expect(registry).toContain('verify-drawer')
    expect(registry).toContain('layer: L2')

    createStagingAsset({ projectRoot, taskId: 't2', name: 'to-discard', purpose: 'x' })
    expect(settleStagingAsset({ projectRoot, name: 'to-discard', decision: 'discard' }).status).toBe('discard')

    createStagingAsset({ projectRoot, taskId: 't3', name: 'to-propose', purpose: 'x' })
    const proposed = settleStagingAsset({ projectRoot, name: 'to-propose', decision: 'propose-l1', reason: 'cross project' })
    expect(proposed.promotionBundle).toBeDefined()
    expect(existsSync(path.join(proposed.promotionBundle as string, 'promotion.yaml'))).toBe(true)

    createStagingAsset({ projectRoot, taskId: 't4', name: 'to-debt', purpose: 'x' })
    const debt = settleStagingAsset({ projectRoot, name: 'to-debt', decision: 'debt', reason: 'later' })
    expect(debt.status).toBe('debt')
    expect(existsSync(path.join(debt.targetPath as string, 'debt.yaml'))).toBe(true)
  })

  it('rejects duplicate staging promotion unless forced', () => {
    createStagingAsset({ projectRoot, taskId: 't1', name: 'dup', purpose: 'x' })
    settleStagingAsset({ projectRoot, name: 'dup', decision: 'promote-l2', allowRepoWrite: true })
    createStagingAsset({ projectRoot, taskId: 't2', name: 'dup', purpose: 'x' })
    expect(() => settleStagingAsset({ projectRoot, name: 'dup', decision: 'promote-l2', allowRepoWrite: true })).toThrow(AssetError)
  })

  it('audits stale, unused, broken and duplicates', () => {
    write(path.join(projectRoot, '.agent/assets/packs/ok/run.mjs'), '// ok')
    write(path.join(projectRoot, '.agent/assets/packs/broken/run.mjs'), '// broken')
    writeYaml(path.join(projectRoot, '.agent/assets/registry.yaml'), {
      version: 1,
      assets: [
        { id: 'ok', layer: 'L2', entry: 'packs/ok/run.mjs', last_verified: '2026-11-20', usage_count: 3 },
        { id: 'stale', layer: 'L2', entry: 'packs/ok/run.mjs', last_verified: '2025-01-01', usage_count: 0 },
        { id: 'broken', layer: 'L2', entry: 'packs/no-such/run.mjs', last_verified: '2026-11-20' },
      ],
    })
    const report = auditAssets({ projectRoot, now: NOW })
    expect(report.summary.total).toBe(3)
    expect(report.stale.map(item => item.id)).toContain('stale')
    expect(report.unused.map(item => item.id)).toContain('stale')
    expect(report.broken.map(item => item.id)).toContain('broken')
    expect(report.duplicates.length).toBeGreaterThan(0)
    const diagnosis = diagnoseAsset({ projectRoot, id: 'ok', now: NOW })
    expect(diagnosis.entryExists).toBe(true)
    expect(diagnosis.health).toBe('ok')
  })
})
