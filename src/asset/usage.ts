import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJson } from './paths.js'

export interface UsageEvent {
  ts: string
  taskId?: string
  assetId: string
  version?: string
  status: string
  durationMs?: number
  source: 'project' | 'library'
}

export interface TrustEntry {
  lastVerified?: string
  lastUsed?: string
}

export type TrustMap = Record<string, TrustEntry>

export interface UsageLocation {
  stateRoot?: string
  projectRoot: string
}

function stateDir(location: UsageLocation): string {
  return location.stateRoot === undefined || location.stateRoot.trim() === ''
    ? path.join(path.resolve(location.projectRoot), '.agent/assets')
    : path.resolve(location.stateRoot)
}

export function appendUsage(location: UsageLocation, event: UsageEvent): void {
  const file = path.join(stateDir(location), 'metrics', 'usage.jsonl')
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
}

export function readUsage(location: UsageLocation): UsageEvent[] {
  const file = path.join(stateDir(location), 'metrics', 'usage.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim()
    if (trimmed === '') return []
    try {
      return [JSON.parse(trimmed) as UsageEvent]
    } catch {
      return []
    }
  })
}

/** 近 N 天使用次数；用于 audit 的 unused 判断。 */
export function usageCounts(location: UsageLocation, days = 90, now = new Date()): Map<string, number> {
  const since = now.getTime() - days * 86_400_000
  const counts = new Map<string, number>()
  for (const event of readUsage(location)) {
    const ts = Date.parse(event.ts)
    if (Number.isNaN(ts) || ts < since) continue
    counts.set(event.assetId, (counts.get(event.assetId) ?? 0) + 1)
  }
  return counts
}

export function readTrust(location: UsageLocation): TrustMap {
  return readJson<TrustMap>(path.join(stateDir(location), 'trust.json')) ?? {}
}

export function writeTrust(location: UsageLocation, trust: TrustMap): void {
  const file = path.join(stateDir(location), 'trust.json')
  ensureDir(path.dirname(file))
  writeJson(file, trust)
}

export function updateTrust(location: UsageLocation, assetId: string, patch: TrustEntry): TrustMap {
  const trust = readTrust(location)
  trust[assetId] = { ...trust[assetId], ...patch }
  writeTrust(location, trust)
  return trust
}
