import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AssetError, type AssetEntry, type AssetHealth, type AssetLayer, type RegistryFile, type RegistryIssue, type RegistrySnapshot, type ResolvedAsset } from './types.js'
import { daysBetween, projectAssetsRoot, resolveLexicalInside } from './paths.js'

const LAYERS = new Set<AssetLayer>(['L0', 'L1', 'L2', 'L3'])
const STALE_DAYS = 90

interface RawAsset {
  id?: unknown
  layer?: unknown
  entry?: unknown
  inputs?: unknown
  outputs?: unknown
  owner?: unknown
  version?: unknown
  last_verified?: unknown
  known_limits?: unknown
  tags?: unknown
  usage_count?: unknown
  purpose?: unknown
  runtime?: unknown
}


/** 常见口语标签 → 资产 tags 的别名；避免 agent 搜“抽屉/外链”命中不了 web/ui。 */
const TAG_ALIASES: Record<string, string[]> = {
  '抽屉': ['ui', 'drawer'],
  '外链': ['ui', 'link', 'url'],
  '链接': ['ui', 'link', 'url'],
  'url': ['ui', 'url', 'link'],
  '断言': ['assertions', 'test'],
  '判定': ['assertions', 'url'],
  '预览': ['preview'],
  'preview': ['preview'],
  '空态': ['states'],
  'mock': ['mock'],
  '截图': ['screenshot'],
  'screenshot': ['screenshot'],
  'verify': ['verify'],
  'node': ['node'],
  'ui': ['ui'],
  'web': ['web'],
}

export function matchesTags(assetTags: string[] | undefined, queryTags: string[]): boolean {
  const tags = assetTags ?? []
  return queryTags.every(tag => {
    const aliases = TAG_ALIASES[tag] ?? [tag]
    return aliases.some(alias => tags.includes(alias))
  })
}

export interface AssetPin {
  library?: string
  runners?: Record<string, string>
}

export interface LoadSnapshotOptions {
  projectRoot: string
  libraryRoot?: string
  now?: Date
}

export interface SearchOptions {
  tags?: string[]
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return out.length > 0 ? out : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseEntry(raw: RawAsset, root: string, source: 'project' | 'library', issues: RegistryIssue[], index: number, now: Date): ResolvedAsset | undefined {
  const id = asString(raw.id)
  if (id === undefined) {
    issues.push({ code: 'INVALID_MANIFEST', message: `assets[${index}] 缺少 id` })
    return undefined
  }
  const layerRaw = asString(raw.layer)
  if (layerRaw === undefined || !LAYERS.has(layerRaw as AssetLayer)) {
    issues.push({ code: 'INVALID_MANIFEST', message: `${id}: layer 必须是 L0/L1/L2/L3`, assetId: id })
    return undefined
  }
  const entry = asString(raw.entry)
  if (entry === undefined) {
    issues.push({ code: 'INVALID_MANIFEST', message: `${id}: 缺少 entry`, assetId: id })
    return undefined
  }
  let entryPath: string
  try {
    entryPath = resolveLexicalInside(root, entry)
  } catch (error) {
    issues.push({ code: 'PATH_ESCAPE', message: `${id}: entry 越界（${(error as Error).message}）`, assetId: id })
    return undefined
  }
  const lastVerified = asString(raw.last_verified)
  const ageDays = lastVerified === undefined ? undefined : daysBetween(lastVerified, now)
  let health: AssetHealth = 'ok'
  if (!fs.existsSync(entryPath)) health = 'missing'
  else if (lastVerified === undefined || ageDays === undefined) health = 'invalid'
  else if (ageDays > STALE_DAYS) health = 'stale'

  return {
    id,
    layer: layerRaw as AssetLayer,
    entry,
    inputs: asStringArray(raw.inputs),
    outputs: asStringArray(raw.outputs),
    owner: asString(raw.owner),
    version: asString(raw.version),
    lastVerified,
    knownLimits: asStringArray(raw.known_limits),
    tags: asStringArray(raw.tags),
    usageCount: asNumber(raw.usage_count),
    purpose: asString(raw.purpose),
    runtime: asString(raw.runtime) as AssetEntry['runtime'],
    source,
    registryRoot: root,
    entryPath,
    health,
    ageDays,
  }
}

function parseRegistryFile(file: string, root: string, source: 'project' | 'library', issues: RegistryIssue[], now: Date): ResolvedAsset[] {
  if (!fs.existsSync(file)) {
    if (source === 'library') issues.push({ code: 'LIBRARY_NOT_FOUND', message: `共享库 registry 不存在：${file}` })
    return []
  }
  let raw: unknown
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    issues.push({ code: 'INVALID_MANIFEST', message: `YAML 解析失败：${file}：${(error as Error).message}` })
    return []
  }
  if (raw === null || typeof raw !== 'object') {
    issues.push({ code: 'INVALID_MANIFEST', message: `registry 必须是对象：${file}` })
    return []
  }
  const record = raw as { version?: unknown; assets?: unknown }
  if (record.version !== 1) {
    issues.push({ code: 'INVALID_MANIFEST', message: `registry.version 必须是 1：${file}` })
    return []
  }
  if (!Array.isArray(record.assets)) {
    issues.push({ code: 'INVALID_MANIFEST', message: `registry.assets 必须是数组：${file}` })
    return []
  }
  const out: ResolvedAsset[] = []
  const seen = new Set<string>()
  record.assets.forEach((item, index) => {
    if (item === null || typeof item !== 'object') {
      issues.push({ code: 'INVALID_MANIFEST', message: `assets[${index}] 不是对象` })
      return
    }
    const parsed = parseEntry(item as RawAsset, root, source, issues, index, now)
    if (parsed === undefined) return
    if (seen.has(parsed.id)) {
      issues.push({ code: 'DUPLICATE_ID', message: `${parsed.id}: registry 内 id 重复`, assetId: parsed.id })
      return
    }
    seen.add(parsed.id)
    out.push(parsed)
  })
  return out
}

/** 读取 .agent/assets.yaml 的 pin；不存在时返回空对象。 */
export function loadPin(projectRoot: string): AssetPin {
  const file = path.join(projectRoot, '.agent', 'assets.yaml')
  if (!fs.existsSync(file)) return {}
  try {
    const raw = parseYaml(fs.readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    const record = raw as { library?: unknown; runners?: unknown }
    const library = asString(record.library)
    const runners: Record<string, string> = {}
    if (record.runners !== null && typeof record.runners === 'object' && !Array.isArray(record.runners)) {
      for (const [key, value] of Object.entries(record.runners as Record<string, unknown>)) {
        const version = asString(value)
        if (version !== undefined) runners[key] = version
      }
    }
    return { ...(library === undefined ? {} : { library }), ...(Object.keys(runners).length === 0 ? {} : { runners }) }
  } catch {
    return {}
  }
}

function assertVersion(version: string): string {
  if (!/^[0-9A-Za-z._-]+$/.test(version) || version === '.' || version === '..') {
    throw new AssetError('INVALID_MANIFEST', `非法库版本：${version}`)
  }
  return version
}

/** 加载并合并项目 registry 与共享库 registry；项目同 id 覆盖库。 */
export function loadSnapshot(options: LoadSnapshotOptions): RegistrySnapshot {
  const projectRoot = path.resolve(options.projectRoot)
  const projectRootAssets = projectAssetsRoot(projectRoot)
  const issues: RegistryIssue[] = []
  const now = options.now ?? new Date()
  const projectAssets = parseRegistryFile(path.join(projectRootAssets, 'registry.yaml'), projectRootAssets, 'project', issues, now)

  const pin = loadPin(projectRoot)
  if (options.libraryRoot !== undefined && pin.library === undefined) {
    issues.push({ code: 'PIN_MISSING', message: '缺少 .agent/assets.yaml 的 library pin；请确认 project_root 指向任务 worktree' })
  }
  let libraryRoot: string | undefined
  let libraryVersion: string | undefined
  let libraryAssets: ResolvedAsset[] = []
  if (options.libraryRoot !== undefined && options.libraryRoot.trim() !== '') {
    const root = path.resolve(options.libraryRoot)
    const version = pin.library === undefined ? 'current' : assertVersion(pin.library)
    const dir = path.join(root, version)
    if (!fs.existsSync(dir)) {
      issues.push({ code: 'LIBRARY_NOT_FOUND', message: `共享库版本不存在：${dir}` })
    } else {
      libraryRoot = root
      libraryVersion = version
      libraryAssets = parseRegistryFile(path.join(dir, 'registry.yaml'), dir, 'library', issues, now)
    }
  }

  const merged = new Map<string, ResolvedAsset>()
  for (const asset of libraryAssets) merged.set(asset.id, asset)
  for (const asset of projectAssets) {
    if (merged.has(asset.id)) {
      const shadowed = merged.get(asset.id) as ResolvedAsset
      issues.push({ code: 'SHADOWED_ID', message: `${asset.id}: 项目资产覆盖了共享库 ${shadowed.version ?? '未标版本'}`, assetId: asset.id })
    }
    merged.set(asset.id, asset)
  }

  return {
    projectRoot,
    projectAssetsRoot: projectRootAssets,
    ...(libraryRoot === undefined ? {} : { libraryRoot }),
    ...(libraryVersion === undefined ? {} : { libraryVersion }),
    assets: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)),
    issues,
  }
}

/** 按 tags 搜索（所有 tag 都必须命中）；项目优先、健康优先、L2/L1/L0 依次。 */
export function searchAssets(snapshot: RegistrySnapshot, options: SearchOptions = {}): ResolvedAsset[] {
  const tags = (options.tags ?? []).filter(tag => tag.trim() !== '')
  const rank = (asset: ResolvedAsset): number => {
    const health = asset.health === 'ok' ? 0 : asset.health === 'stale' ? 1 : 2
    const source = asset.source === 'project' ? 0 : 1
    const layer = asset.layer === 'L3' ? 3 : asset.layer === 'L2' ? 0 : asset.layer === 'L1' ? 1 : 2
    return health * 100 + source * 10 + layer
  }
  return snapshot.assets
    .filter(asset => matchesTags(asset.tags, tags))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
}

export function resolveAsset(snapshot: RegistrySnapshot, id: string): ResolvedAsset {
  const asset = snapshot.assets.find(item => item.id === id)
  if (asset === undefined) throw new AssetError('ASSET_NOT_FOUND', `未注册资产：${id}`)
  return asset
}

function toRawEntry(asset: AssetEntry): Record<string, unknown> {
  return {
    id: asset.id,
    layer: asset.layer,
    entry: asset.entry,
    ...(asset.inputs === undefined ? {} : { inputs: asset.inputs }),
    ...(asset.outputs === undefined ? {} : { outputs: asset.outputs }),
    ...(asset.owner === undefined ? {} : { owner: asset.owner }),
    ...(asset.version === undefined ? {} : { version: asset.version }),
    ...(asset.lastVerified === undefined ? {} : { last_verified: asset.lastVerified }),
    ...(asset.knownLimits === undefined ? {} : { known_limits: asset.knownLimits }),
    ...(asset.tags === undefined ? {} : { tags: asset.tags }),
    ...(asset.usageCount === undefined ? {} : { usage_count: asset.usageCount }),
    ...(asset.purpose === undefined ? {} : { purpose: asset.purpose }),
    ...(asset.runtime === undefined ? {} : { runtime: asset.runtime }),
  }
}

/** 读取项目 registry 的规范化条目（用于 staging 写入前合并）。 */
export function readProjectRegistry(projectRoot: string): AssetEntry[] {
  const root = projectAssetsRoot(path.resolve(projectRoot))
  const issues: RegistryIssue[] = []
  return parseRegistryFile(path.join(root, 'registry.yaml'), root, 'project', issues, new Date()).map(toEntry)
}

function toEntry(asset: ResolvedAsset): AssetEntry {
  return {
    id: asset.id,
    layer: asset.layer,
    entry: asset.entry,
    ...(asset.inputs === undefined ? {} : { inputs: asset.inputs }),
    ...(asset.outputs === undefined ? {} : { outputs: asset.outputs }),
    ...(asset.owner === undefined ? {} : { owner: asset.owner }),
    ...(asset.version === undefined ? {} : { version: asset.version }),
    ...(asset.lastVerified === undefined ? {} : { lastVerified: asset.lastVerified }),
    ...(asset.knownLimits === undefined ? {} : { knownLimits: asset.knownLimits }),
    ...(asset.tags === undefined ? {} : { tags: asset.tags }),
    ...(asset.usageCount === undefined ? {} : { usageCount: asset.usageCount }),
    ...(asset.purpose === undefined ? {} : { purpose: asset.purpose }),
    ...(asset.runtime === undefined ? {} : { runtime: asset.runtime }),
  }
}

/** 写回项目 registry（只允许项目根内）。 */
export function writeProjectRegistry(projectRoot: string, assets: AssetEntry[]): void {
  const root = projectAssetsRoot(path.resolve(projectRoot))
  const file = path.join(root, 'registry.yaml')
  const normalized: RegistryFile = {
    version: 1,
    assets: [...assets].sort((a, b) => a.id.localeCompare(b.id)),
  }
  fs.mkdirSync(root, { recursive: true })
  const text = stringifyYaml({
    version: normalized.version,
    assets: normalized.assets.map(toRawEntry),
  })
  fs.writeFileSync(file, text, 'utf8')
}

/** 插入或覆盖一条项目资产。 */
export function upsertProjectAsset(projectRoot: string, asset: AssetEntry): void {
  const existing = readProjectRegistry(projectRoot).filter(item => item.id !== asset.id)
  existing.push(asset)
  writeProjectRegistry(projectRoot, existing)
}
