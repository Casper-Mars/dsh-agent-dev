import fs from 'node:fs'
import path from 'node:path'
import { AssetError, type AuditItem, type AuditReport, type Diagnosis } from './types.js'
import { daysBetween } from './paths.js'
import { loadSnapshot, resolveAsset, type LoadSnapshotOptions } from './registry.js'

export interface AuditOptions extends LoadSnapshotOptions {
  staleDays?: number
  unusedDays?: number
  minUsage?: number
  usageCounts?: Map<string, number>
}

export interface DiagnoseOptions extends LoadSnapshotOptions {
  id: string
}

function itemOf(asset: { id: string; source: 'project' | 'library'; layer: 'L0' | 'L1' | 'L2' | 'L3' }, reason: string): AuditItem {
  return { id: asset.id, source: asset.source, layer: asset.layer, reason }
}

/** 扫描 stale / unused / duplicates / broken；不执行 smoke（避免审计本身太贵）。 */
export function auditAssets(options: AuditOptions): AuditReport {
  const now = options.now ?? new Date()
  const staleDays = options.staleDays ?? 90
  const unusedDays = options.unusedDays ?? 90
  const minUsage = options.minUsage ?? 2
  const snapshot = loadSnapshot({ ...options, now })

  const stale: AuditItem[] = []
  const unused: AuditItem[] = []
  const broken: AuditItem[] = []
  const duplicates: AuditItem[] = []

  for (const asset of snapshot.assets) {
    const ageDays = asset.lastVerified === undefined ? undefined : daysBetween(asset.lastVerified, now)
    if (asset.health === 'missing') broken.push(itemOf(asset, 'entry 不存在'))
    if (asset.health === 'invalid') stale.push(itemOf(asset, 'last_verified 缺失或非法'))
    else if (ageDays !== undefined && ageDays > staleDays) stale.push(itemOf(asset, `超过 ${staleDays} 天未验证`))
    const usageCount = options.usageCounts?.get(asset.id) ?? asset.usageCount ?? 0
    if (usageCount < minUsage && ageDays !== undefined && ageDays > unusedDays) {
      unused.push(itemOf(asset, `使用次数 ${usageCount} < ${minUsage}`))
    }
  }

  for (const issue of snapshot.issues) {
    if (issue.code !== 'DUPLICATE_ID' && issue.code !== 'SHADOWED_ID') continue
    const target = snapshot.assets.find(asset => asset.id === issue.assetId)
    duplicates.push({
      id: issue.assetId ?? '(unknown)',
      source: target?.source ?? (issue.code === 'SHADOWED_ID' ? 'project' : 'library'),
      layer: target?.layer ?? 'L0',
      reason: issue.message,
    })
  }

  const byEntry = new Map<string, typeof snapshot.assets>()
  for (const asset of snapshot.assets) {
    const key = path.resolve(asset.entryPath)
    const list = byEntry.get(key) ?? []
    list.push(asset)
    byEntry.set(key, list)
  }
  for (const list of byEntry.values()) {
    if (list.length < 2) continue
    for (const asset of list) duplicates.push(itemOf(asset, `entry 与其它资产重复：${asset.entryPath}`))
  }

  return {
    stale,
    unused,
    duplicates,
    broken,
    issues: snapshot.issues,
    summary: {
      total: snapshot.assets.length,
      stale: stale.length,
      unused: unused.length,
      duplicates: duplicates.length,
      broken: broken.length,
    },
  }
}

/** 单资产诊断：不跑 smoke，只回事实。 */
export function diagnoseAsset(options: DiagnoseOptions): Diagnosis {
  const now = options.now ?? new Date()
  const snapshot = loadSnapshot({ ...options, now })
  const asset = resolveAsset(snapshot, options.id)
  const ageDays = asset.lastVerified === undefined ? undefined : daysBetween(asset.lastVerified, now)
  const entryExists = fs.existsSync(asset.entryPath)
  if (!entryExists && asset.health !== 'missing') {
    throw new AssetError('ASSET_NOT_FOUND', `${asset.id}: entry 不存在（${asset.entryPath}）`)
  }
  return {
    id: asset.id,
    source: asset.source,
    layer: asset.layer,
    ...(asset.version === undefined ? {} : { version: asset.version }),
    ...(asset.lastVerified === undefined ? {} : { lastVerified: asset.lastVerified }),
    ...(ageDays === undefined ? {} : { ageDays }),
    entryPath: asset.entryPath,
    entryExists,
    health: asset.health,
    knownLimits: asset.knownLimits ?? [],
  }
}
