import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { matchesTags } from './registry.js'

export type LocalAssetHealth = 'staging' | 'debt' | 'promotion'

export interface LocalAssetHit {
  id: string
  layer: 'L3'
  source: 'project'
  health: LocalAssetHealth
  path: string
  entry: string
  tags: string[]
  purpose?: string
}

function readManifest(dir: string): { id: string; tags: string[]; purpose?: string; entry?: string } | undefined {
  const file = path.join(dir, 'asset.yaml')
  if (!fs.existsSync(file)) return undefined
  try {
    const raw = parseYaml(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : path.basename(dir)
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === 'string') : []
    const purpose = typeof raw.purpose === 'string' ? raw.purpose : undefined
    const entry = typeof raw.entry === 'string' ? raw.entry : undefined
    return { id, tags, ...(purpose === undefined ? {} : { purpose }), ...(entry === undefined ? {} : { entry }) }
  } catch {
    return undefined
  }
}

function scan(root: string, health: LocalAssetHealth, taskLevel: boolean): LocalAssetHit[] {
  if (!fs.existsSync(root)) return []
  const out: LocalAssetHit[] = []
  const taskDirs = taskLevel
    ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))
    : [root]
  for (const taskDir of taskDirs) {
    if (!fs.existsSync(taskDir) || !fs.statSync(taskDir).isDirectory()) continue
    const dirs = taskLevel
      ? fs.readdirSync(taskDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(taskDir, entry.name))
      : fs.readdirSync(taskDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(taskDir, entry.name))
    for (const dir of dirs) {
      const manifest = readManifest(dir)
      if (manifest === undefined) continue
      out.push({
        id: manifest.id,
        layer: 'L3',
        source: 'project',
        health,
        path: dir,
        entry: manifest.entry ?? 'run.mjs',
        tags: manifest.tags,
        ...(manifest.purpose === undefined ? {} : { purpose: manifest.purpose }),
      })
    }
  }
  return out
}

export function searchLocalAssets(options: { projectRoot: string; stateRoot?: string; tags?: string[] }): LocalAssetHit[] {
  const projectRoot = path.resolve(options.projectRoot)
  const stateRoot = options.stateRoot === undefined ? undefined : path.resolve(options.stateRoot)
  const tags = options.tags ?? []
  const hits = [
    ...scan(path.join(projectRoot, '.agent/assets/staging'), 'staging', true),
    ...scan(path.join(projectRoot, '.agent/assets/debt'), 'debt', false),
    ...scan(path.join(projectRoot, '.agent/assets/promotions'), 'promotion', false),
    ...(stateRoot === undefined ? [] : scan(path.join(stateRoot, 'debt'), 'debt', false)),
    ...(stateRoot === undefined ? [] : scan(path.join(stateRoot, 'promotions'), 'promotion', false)),
  ]
  const seen = new Set<string>()
  return hits.filter(hit => {
    if (seen.has(hit.path)) return false
    seen.add(hit.path)
    return tags.length === 0 || matchesTags(hit.tags, tags)
  })
}

export function findLocalAsset(options: { projectRoot: string; stateRoot?: string; name: string }): LocalAssetHit | undefined {
  return searchLocalAssets({ projectRoot: options.projectRoot, ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }) })
    .find(hit => hit.id === options.name)
}
