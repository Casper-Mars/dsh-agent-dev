import fs from 'node:fs'
import path from 'node:path'
import { AssetError, type SettleDecision } from './types.js'
import { ensureDir, writeJson, readJson } from './paths.js'

export interface AssetUse {
  id: string
  version?: string
}

export interface CardLedger {
  taskId: string
  pending: string[]
  used: AssetUse[]
  created: string[]
  promoted: string[]
  discarded: string[]
  debt: string[]
  actions: { run: number; create: number; audit: number; settle: number }
  stagingSettled: boolean
  updatedAt: string
}

export interface LedgerLocation {
  stateRoot?: string
  projectRoot: string
}

function ledgerDir(location: LedgerLocation): string {
  const root = location.stateRoot === undefined || location.stateRoot.trim() === ''
    ? path.join(path.resolve(location.projectRoot), '.agent/assets')
    : path.resolve(location.stateRoot)
  return path.join(root, 'ledger')
}

function emptyLedger(taskId: string): CardLedger {
  return {
    taskId,
    pending: [],
    used: [],
    created: [],
    promoted: [],
    discarded: [],
    debt: [],
    actions: { run: 0, create: 0, audit: 0, settle: 0 },
    stagingSettled: false,
    updatedAt: new Date().toISOString(),
  }
}

export function readLedger(location: LedgerLocation, taskId: string): CardLedger {
  const file = path.join(ledgerDir(location), `${taskId}.json`)
  return readJson<CardLedger>(file) ?? emptyLedger(taskId)
}

export function writeLedger(location: LedgerLocation, ledger: CardLedger): void {
  const file = path.join(ledgerDir(location), `${ledger.taskId}.json`)
  ensureDir(path.dirname(file))
  ledger.updatedAt = new Date().toISOString()
  writeJson(file, ledger)
}

export function updateLedger(location: LedgerLocation, taskId: string, mutate: (ledger: CardLedger) => void): CardLedger {
  const ledger = readLedger(location, taskId)
  mutate(ledger)
  writeLedger(location, ledger)
  return ledger
}

export function markUsed(location: LedgerLocation, taskId: string, id: string, version?: string): void {
  updateLedger(location, taskId, ledger => {
    if (!ledger.used.some(item => item.id === id && item.version === version)) {
      ledger.used.push({ id, ...(version === undefined ? {} : { version }) })
    }
  })
}

export function markCreated(location: LedgerLocation, taskId: string, name: string): void {
  updateLedger(location, taskId, ledger => {
    ledger.actions.create += 1
    ledger.created.push(name)
    if (!ledger.pending.includes(name)) ledger.pending.push(name)
    ledger.stagingSettled = false
  })
}

export function markSettled(location: LedgerLocation, taskId: string, name: string, decision: SettleDecision): void {
  updateLedger(location, taskId, ledger => {
    ledger.actions.settle += 1
    ledger.pending = ledger.pending.filter(item => item !== name)
    if (decision === 'discard') ledger.discarded.push(name)
    else if (decision === 'debt') ledger.debt.push(name)
    else ledger.promoted.push(`${name} (${decision})`)
    ledger.stagingSettled = ledger.pending.length === 0
  })
}

export function recordAction(location: LedgerLocation, taskId: string, action: 'run' | 'audit'): void {
  updateLedger(location, taskId, ledger => {
    ledger.actions[action] += 1
  })
}

export function finalizeLedger(location: LedgerLocation, taskId: string): CardLedger {
  const ledger = readLedger(location, taskId)
  if (ledger.pending.length > 0) {
    throw new AssetError('SETTLE_CONFLICT', `staging 未结算：${ledger.pending.join('、')}`)
  }
  ledger.stagingSettled = true
  writeLedger(location, ledger)
  return ledger
}

export function assetBlock(ledger: CardLedger): string {
  const list = (items: string[]): string => (items.length === 0 ? '无' : items.join('、'))
  const used = ledger.used.length === 0 ? '无' : ledger.used.map(item => `${item.id}${item.version === undefined ? '' : `@${item.version}`}`).join('、')
  return [
    '## 资产',
    `- used: ${used}`,
    `- created: ${list(ledger.created)}`,
    `- promoted: ${list(ledger.promoted)}`,
    `- discarded: ${list(ledger.discarded)}`,
    `- debt: ${list(ledger.debt)}`,
    `- staging: ${ledger.stagingSettled ? 'settled' : 'pending'}`,
  ].join('\n')
}
