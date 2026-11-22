/** 资产核心类型：与 dsh 运行时无关，供 tool / CI / 单测共用。 */
export type AssetLayer = 'L0' | 'L1' | 'L2' | 'L3'
export type AssetSource = 'project' | 'library'
export type AssetHealth = 'ok' | 'stale' | 'missing' | 'invalid'

/** registry.yaml 中的一条资产声明（驼峰字段由 YAML 的 snake_case 映射而来）。 */
export interface AssetEntry {
  id: string
  layer: AssetLayer
  /** 相对 registry 根目录的入口路径。 */
  entry: string
  inputs?: string[]
  outputs?: string[]
  owner?: string
  version?: string
  /** ISO 日期（YYYY-MM-DD）。 */
  lastVerified?: string
  knownLimits?: string[]
  tags?: string[]
  usageCount?: number
  purpose?: string
  /** 入口运行时；缺省按扩展名推断。 */
  runtime?: 'node' | 'bash' | 'python3'
  /** L3/L2 依赖的其它资产；缺失/不健康时 run 拒绝。 */
  requires?: AssetRequirement[]
}

export interface AssetRequirement {
  id: string
  version?: string
}

export interface RegistryFile {
  version: 1
  assets: AssetEntry[]
}

export interface RegistryIssue {
  code: string
  message: string
  assetId?: string
}

/** 解析后的资产：带来源、真实入口路径与健康状态。 */
export interface ResolvedAsset extends AssetEntry {
  source: AssetSource
  registryRoot: string
  entryPath: string
  health: AssetHealth
  ageDays?: number
}

export interface RegistrySnapshot {
  projectRoot: string
  projectAssetsRoot: string
  libraryRoot?: string
  libraryVersion?: string
  assets: ResolvedAsset[]
  issues: RegistryIssue[]
}

export type AssetErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'INVALID_MANIFEST'
  | 'PATH_ESCAPE'
  | 'INVALID_NAME'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RUN_FAILED'
  | 'SETTLE_CONFLICT'
  | 'LIBRARY_READ_ONLY'
  | 'IO_ERROR'
  | 'REPO_WRITE_DENIED'
  | 'BUDGET_EXCEEDED'

export class AssetError extends Error {
  readonly code: AssetErrorCode
  readonly details?: unknown

  constructor(code: AssetErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AssetError'
    this.code = code
    this.details = details
  }
}

export type RunStatus = 'passed' | 'failed' | 'timeout' | 'cancelled'

export interface RunDiagnosis {
  code: string
  message: string
  details?: unknown
}

export interface RunResult {
  status: RunStatus
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  result?: unknown
  resultPath?: string
  artifacts: string[]
  diagnosis?: RunDiagnosis
}

export type SettleDecision = 'promote-l2' | 'propose-l2' | 'propose-l1' | 'discard' | 'debt'

export interface SettleResult {
  status: SettleDecision | 'failed'
  sourcePath?: string
  targetPath?: string
  registryUpdated: boolean
  promotionBundle?: string
  reason?: string
}

export interface CreateStagingOptions {
  projectRoot: string
  taskId: string
  name: string
  purpose: string
  inputs?: string[]
  outputs?: string[]
  owner?: string
  reuseExpect?: number
  tags?: string[]
  knownLimits?: string[]
  requires?: AssetRequirement[]
  scenario?: unknown
}

export interface StagingResult {
  stagingPath: string
  files: string[]
}

export interface SettleOptions {
  projectRoot: string
  name?: string
  stagingPath?: string
  decision: SettleDecision
  reason?: string
  owner?: string
  reuseExpect?: number
  force?: boolean
  allowRepoWrite?: boolean
  debtRoot?: string
}

export interface AuditItem {
  id: string
  source: AssetSource
  layer: AssetLayer
  reason: string
}

export interface AuditReport {
  stale: AuditItem[]
  unused: AuditItem[]
  duplicates: AuditItem[]
  broken: AuditItem[]
  issues: RegistryIssue[]
  summary: {
    total: number
    stale: number
    unused: number
    duplicates: number
    broken: number
  }
}

export interface Diagnosis {
  id: string
  source: AssetSource
  layer: AssetLayer
  version?: string
  lastVerified?: string
  ageDays?: number
  entryPath: string
  entryExists: boolean
  health: AssetHealth
  knownLimits: string[]
}
