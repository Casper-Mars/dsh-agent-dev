import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AssetError, type AssetEntry, type CreateStagingOptions, type SettleOptions, type SettleResult, type StagingResult } from './types.js'
import { assertAssetName, assertTaskId, ensureDir, movePath, projectAssetsRoot, removePath, resolveInside, writeJson } from './paths.js'
import { readProjectRegistry, upsertProjectAsset } from './registry.js'

interface StagingManifest {
  id: string
  layer: 'L3'
  purpose?: string
  inputs?: string[]
  outputs?: string[]
  entry?: string
  owner?: string
  reuse_expect?: number
  created_from?: string
  status?: string
  tags?: string[]
  known_limits?: string[]
  requires?: { id: string; version?: string }[]
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return out.length > 0 ? out : undefined
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function bumpVersion(version: string | undefined): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (match === null) return '0.1.0'
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function stagingRoot(projectRoot: string): string {
  return path.join(projectAssetsRoot(path.resolve(projectRoot)), 'staging')
}

function readManifest(dir: string): StagingManifest {
  const file = path.join(dir, 'asset.yaml')
  if (!fs.existsSync(file)) throw new AssetError('INVALID_MANIFEST', `缺少 asset.yaml：${dir}`)
  let raw: unknown
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new AssetError('INVALID_MANIFEST', `asset.yaml 解析失败：${(error as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object') throw new AssetError('INVALID_MANIFEST', `asset.yaml 必须是对象：${dir}`)
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (id === '') throw new AssetError('INVALID_MANIFEST', `asset.yaml 缺少 id：${dir}`)
  return {
    id,
    layer: 'L3',
    ...(typeof record.purpose === 'string' ? { purpose: record.purpose } : {}),
    ...(asStringArray(record.inputs) === undefined ? {} : { inputs: asStringArray(record.inputs) }),
    ...(asStringArray(record.outputs) === undefined ? {} : { outputs: asStringArray(record.outputs) }),
    ...(typeof record.entry === 'string' ? { entry: record.entry } : {}),
    ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
    ...(typeof record.reuse_expect === 'number' ? { reuse_expect: record.reuse_expect } : {}),
    ...(typeof record.created_from === 'string' ? { created_from: record.created_from } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(asStringArray(record.tags) === undefined ? {} : { tags: asStringArray(record.tags) }),
    ...(asStringArray(record.known_limits) === undefined ? {} : { known_limits: asStringArray(record.known_limits) }),
    ...(Array.isArray(record.requires) ? { requires: record.requires.filter((item): item is { id: string; version?: string } => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') } : {}),
  }
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'asset.yaml'), stringifyYaml(manifest), 'utf8')
}

/** 在 staging 建一个 L3 脚手架；只写项目 .agent/assets/staging。 */
export function createStagingAsset(options: CreateStagingOptions): StagingResult {
  const projectRoot = path.resolve(options.projectRoot)
  const name = assertAssetName(options.name)
  const taskId = assertTaskId(options.taskId)
  const root = stagingRoot(projectRoot)
  const dir = resolveInside(root, path.join(taskId, name), 'INVALID_NAME')
  if (fs.existsSync(dir)) throw new AssetError('SETTLE_CONFLICT', `staging 已存在：${dir}`)
  ensureDir(path.join(dir, 'test'))

  writeManifest(dir, {
    id: name,
    layer: 'L3',
    purpose: options.purpose,
    inputs: options.inputs ?? ['scenario.json'],
    outputs: options.outputs ?? ['result.json'],
    entry: 'run.mjs',
    owner: options.owner ?? 'unknown',
    reuse_expect: options.reuseExpect ?? 2,
    created_from: taskId,
    status: 'staging',
    tags: options.tags ?? [],
    known_limits: options.knownLimits ?? [],
    ...(options.requires === undefined ? {} : { requires: options.requires }),
  })

  fs.writeFileSync(path.join(dir, 'run.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const args = process.argv.slice(2)",
    "const at = args.indexOf('--scenario')",
    "const scenarioPath = at >= 0 ? args[at + 1] : 'scenario.json'",
    "const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))",
    '// TODO: implement the reusable verification logic here.',
    'const result = { status: \'failed\', reason: \'TODO: implement asset logic\', assertions: [], artifacts: [], scenario }',
    "writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(result, null, 2))",
    'console.log(JSON.stringify({ status: result.status }))',
    '',
  ].join('\n'), 'utf8')

  writeJson(path.join(dir, 'scenario.json'), options.scenario ?? {})
  const smoke = path.join(dir, 'test', 'smoke.sh')
  fs.writeFileSync(smoke, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")/.."',
    'node run.mjs --scenario scenario.json',
    '',
  ].join('\n'), 'utf8')
  fs.chmodSync(smoke, 0o755)

  return {
    stagingPath: dir,
    files: ['asset.yaml', 'run.mjs', 'scenario.json', 'test/smoke.sh'],
  }
}

/** 找到 staging 目录：优先显式 stagingPath，否则按 name 在 staging/<task>/ 下查找。 */
export function findStagingDir(projectRoot: string, name: string, stagingPath?: string): string {
  const root = stagingRoot(projectRoot)
  if (stagingPath !== undefined && stagingPath.trim() !== '') {
    const dir = resolveInside(root, stagingPath)
    if (!fs.existsSync(dir)) throw new AssetError('ASSET_NOT_FOUND', `staging 不存在：${dir}`)
    return dir
  }
  const safeName = assertAssetName(name)
  const matches: string[] = []
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, safeName)
      if (fs.existsSync(candidate)) matches.push(candidate)
    }
  }
  if (matches.length === 0) throw new AssetError('ASSET_NOT_FOUND', `staging 找不到资产：${safeName}`)
  if (matches.length > 1) throw new AssetError('SETTLE_CONFLICT', `staging 存在多个同名资产：${matches.join(', ')}`)
  return matches[0] as string
}

/** 结算 staging：promote-l2 / propose-l1 / discard / debt。 */
export function settleStagingAsset(options: SettleOptions): SettleResult {
  const projectRoot = path.resolve(options.projectRoot)
  const assetsRoot = projectAssetsRoot(projectRoot)
  const name = options.name === undefined ? undefined : assertAssetName(options.name)
  const dir = findStagingDir(projectRoot, name ?? '', options.stagingPath)
  const manifest = readManifest(dir)
  const assetId = name ?? manifest.id
  if (options.decision === 'promote-l2' && options.allowRepoWrite !== true) {
    throw new AssetError('REPO_WRITE_DENIED', 'promote-l2 会写入项目仓库；未传 allowRepoWrite=true，拒绝执行')
  }
  const targetBase = options.decision === 'promote-l2'
    ? path.join(assetsRoot, 'packs')
    : options.decision === 'propose-l2' || options.decision === 'propose-l1'
      ? path.join(assetsRoot, 'promotions')
      : (options.debtRoot === undefined ? path.join(assetsRoot, 'debt') : path.resolve(options.debtRoot))
  const safeBase = options.decision === 'debt' && options.debtRoot !== undefined ? path.resolve(options.debtRoot) : assetsRoot
  const target = resolveInside(safeBase, path.join(targetBase, assetId))

  if (options.decision === 'discard') {
    removePath(dir)
    return { status: 'discard', sourcePath: dir, registryUpdated: false }
  }

  if (fs.existsSync(target) && options.force !== true) {
    throw new AssetError('SETTLE_CONFLICT', `目标已存在：${target}`)
  }
  if (fs.existsSync(target)) removePath(target)
  movePath(dir, target)

  if (options.decision === 'promote-l2') {
    const entry = path.relative(assetsRoot, path.join(target, manifest.entry ?? 'run.mjs'))
    const existing = readProjectRegistry(projectRoot).find(item => item.id === assetId)
    const asset: AssetEntry = {
      id: assetId,
      layer: 'L2',
      entry,
      ...(manifest.inputs === undefined ? {} : { inputs: manifest.inputs }),
      ...(manifest.outputs === undefined ? {} : { outputs: manifest.outputs }),
      owner: options.owner ?? manifest.owner ?? 'unknown',
      version: bumpVersion(existing?.version ?? '0.1.0'),
      lastVerified: todayIso(),
      ...(manifest.known_limits === undefined ? {} : { knownLimits: manifest.known_limits }),
      ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
      ...(manifest.purpose === undefined ? {} : { purpose: manifest.purpose }),
      ...(manifest.requires === undefined ? {} : { requires: manifest.requires }),
      usageCount: existing?.usageCount ?? 0,
    }
    upsertProjectAsset(projectRoot, asset)
    return { status: 'promote-l2', sourcePath: dir, targetPath: target, registryUpdated: true }
  }

  const meta = {
    id: assetId,
    layer: options.decision === 'propose-l2' ? 'L2' : options.decision === 'propose-l1' ? 'L1' : undefined,
    source_task: manifest.created_from,
    owner: options.owner ?? manifest.owner ?? 'unknown',
    reason: options.reason ?? '',
    reuse_expect: options.reuseExpect ?? manifest.reuse_expect ?? 2,
    created_at: new Date().toISOString(),
  }
  const metaFile = options.decision === 'propose-l1' || options.decision === 'propose-l2' ? 'promotion.yaml' : 'debt.yaml'
  fs.writeFileSync(path.join(target, metaFile), stringifyYaml(meta), 'utf8')
  if (options.decision === 'propose-l1' || options.decision === 'propose-l2') {
    return { status: options.decision, sourcePath: dir, targetPath: target, registryUpdated: false, promotionBundle: target, ...(options.reason === undefined ? {} : { reason: options.reason }) }
  }
  return { status: 'debt', sourcePath: dir, targetPath: target, registryUpdated: false, ...(options.reason === undefined ? {} : { reason: options.reason }) }
}
