import fs from 'node:fs'
import path from 'node:path'
import { AssetError } from './types.js'

/** 项目资产根：<projectRoot>/.agent/assets。 */
export function projectAssetsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.agent', 'assets')
}

/** 判断 target 是否在 root 内（含 root 本身）。 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * 把 target 解析到 root 内并返回真实路径；越界或符号链接逃逸抛 PATH_ESCAPE。
 * target 可以是绝对路径，也可以是相对 root 的路径。
 */
export function resolveInside(root: string, target: string, code: 'PATH_ESCAPE' | 'INVALID_NAME' = 'PATH_ESCAPE'): string {
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root)
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target)
  let real: string
  if (fs.existsSync(abs)) {
    real = fs.realpathSync(abs)
  } else {
    const parent = fs.existsSync(path.dirname(abs)) ? fs.realpathSync(path.dirname(abs)) : path.dirname(abs)
    real = path.join(parent, path.basename(abs))
  }
  if (!isInside(rootReal, real)) {
    throw new AssetError(code, `路径越界：${target} 不在 ${root} 内`)
  }
  return real
}

/** 只做词法校验，不要求路径存在；用于 registry 中可能缺失的 entry。 */
export function resolveLexicalInside(root: string, target: string): string {
  const rootAbs = path.resolve(root)
  const abs = path.isAbsolute(target) ? target : path.resolve(rootAbs, target)
  if (!isInside(rootAbs, abs)) {
    throw new AssetError('PATH_ESCAPE', `路径越界：${target} 不在 ${rootAbs} 内`)
  }
  return abs
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function atomicWrite(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

export function writeJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function movePath(from: string, to: string): void {
  ensureDir(path.dirname(to))
  try {
    fs.renameSync(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

export function removePath(target: string): void {
  fs.rmSync(target, { recursive: true, force: true })
}

/** 合法资产名：小写字母/数字开头，允许连字符。 */
export function assertAssetName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new AssetError('INVALID_NAME', `非法资产名：${name}（要求小写字母/数字/连字符）`)
  }
  return name
}

/** 任务目录名只允许安全字符，避免 path 片段注入。 */
export function assertTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new AssetError('INVALID_NAME', `非法 taskId：${taskId}`)
  }
  return taskId
}

export function daysBetween(fromIso: string, now: Date): number | undefined {
  const from = new Date(`${fromIso}T00:00:00Z`)
  if (Number.isNaN(from.getTime())) return undefined
  return Math.floor((now.getTime() - from.getTime()) / 86_400_000)
}
