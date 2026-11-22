import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AssetError, type ResolvedAsset, type RunDiagnosis, type RunResult } from './types.js'
import { isInside, readJson } from './paths.js'
import { loadSnapshot, resolveAsset } from './registry.js'

export interface RunAssetOptions {
  projectRoot: string
  libraryRoot?: string
  id: string
  scenario?: string
  smoke?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxOutputChars?: number
}

interface SpawnOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  spawnError?: Error
}

function resolveCommand(asset: ResolvedAsset, scenarioPath?: string): { bin: string; args: string[] } {
  const ext = path.extname(asset.entryPath).toLowerCase()
  const runtime = asset.runtime ?? (ext === '.sh' ? 'bash' : ext === '.py' ? 'python3' : 'node')
  if (runtime !== 'node' && runtime !== 'bash' && runtime !== 'python3') {
    throw new AssetError('INVALID_MANIFEST', `${asset.id}: 不支持的 runtime ${runtime}`)
  }
  const bin = runtime === 'node' ? process.execPath : runtime
  const args = [asset.entryPath]
  if (scenarioPath !== undefined) args.push('--scenario', scenarioPath)
  return { bin, args }
}

function resolveScenario(asset: ResolvedAsset, projectRoot: string, scenario: string): string {
  const abs = path.resolve(projectRoot, scenario)
  if (!fs.existsSync(abs)) throw new AssetError('ASSET_NOT_FOUND', `场景文件不存在：${abs}`)
  const real = fs.realpathSync(abs)
  const roots = [path.resolve(projectRoot), asset.registryRoot]
  if (!roots.some(root => isInside(path.resolve(root), real))) {
    throw new AssetError('PATH_ESCAPE', `场景文件越界：${abs}`)
  }
  return real
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（截断，原长 ${text.length} 字符）`
}

function parseResultFile(candidates: string[]): { result: unknown; resultPath?: string } {
  for (const file of candidates) {
    const result = readJson<unknown>(file)
    if (result !== undefined) return { result, resultPath: file }
  }
  return { result: undefined }
}

function parseLastJson(text: string): unknown {
  const lines = text.trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // continue
    }
  }
  return undefined
}

function artifactsOf(result: unknown): string[] {
  if (result === null || typeof result !== 'object') return []
  const record = result as Record<string, unknown>
  const raw = Array.isArray(record.artifacts) ? record.artifacts : Array.isArray(record.screenshots) ? record.screenshots : []
  return raw.filter((item): item is string => typeof item === 'string')
}

/** 执行一个已注册资产；失败返回结构化结果，不抛业务错误（配置错误仍抛 AssetError）。 */
export async function runAsset(options: RunAssetOptions): Promise<RunResult> {
  const projectRoot = path.resolve(options.projectRoot)
  const snapshot = loadSnapshot({ projectRoot, ...(options.libraryRoot === undefined ? {} : { libraryRoot: options.libraryRoot }) })
  const asset = resolveAsset(snapshot, options.id)
  if (!fs.existsSync(asset.entryPath)) {
    throw new AssetError('ASSET_NOT_FOUND', `${asset.id}: entry 不存在（${asset.entryPath}）`)
  }

  let bin: string
  let args: string[]
  let cwd: string
  let scenarioPath: string | undefined
  if (options.smoke === true) {
    const smoke = path.join(path.dirname(asset.entryPath), 'test', 'smoke.sh')
    if (!fs.existsSync(smoke)) throw new AssetError('ASSET_NOT_FOUND', `${asset.id}: 缺少 test/smoke.sh`)
    bin = 'bash'
    args = [smoke]
    cwd = path.dirname(asset.entryPath)
  } else {
    if (options.scenario === undefined || options.scenario.trim() === '') {
      throw new AssetError('INVALID_MANIFEST', `${asset.id}: 非 smoke 运行必须提供 scenario`)
    }
    scenarioPath = resolveScenario(asset, projectRoot, options.scenario)
    const command = resolveCommand(asset, scenarioPath)
    bin = command.bin
    args = command.args
    cwd = options.cwd ?? path.dirname(scenarioPath)
  }

  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 100), 600_000)
  const maxChars = Math.max(options.maxOutputChars ?? 200_000, 1_000)
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  let settled = false
  const started = Date.now()

  let stdout = ''
  let stderr = ''
  const outcome = await new Promise<SpawnOutcome>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      controller.abort()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const child = spawn(bin, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controller.signal,
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxChars) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxChars) stderr += chunk.toString('utf8')
    })
    const finish = (value: SpawnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    child.on('close', (code, signal) => finish({ code, signal, timedOut, cancelled }))
    child.on('error', (error) => finish({ code: null, signal: null, timedOut, cancelled, spawnError: error }))
  })

  const durationMs = Date.now() - started
  const resultCandidates = [
    path.join(path.dirname(asset.entryPath), 'result.json'),
    ...(scenarioPath === undefined ? [] : [path.join(path.dirname(scenarioPath), 'result.json')]),
    path.join(cwd, 'result.json'),
  ]
  const { result: fileResult, resultPath } = parseResultFile(resultCandidates)
  const result = fileResult ?? parseLastJson(stdout)
  const artifacts = artifactsOf(result)

  let status: RunResult['status'] = 'passed'
  let diagnosis: RunDiagnosis | undefined
  if (outcome.cancelled) {
    status = 'cancelled'
    diagnosis = { code: 'CANCELLED', message: '运行被调用方取消' }
  } else if (outcome.timedOut) {
    status = 'timeout'
    diagnosis = { code: 'TIMEOUT', message: `运行超时（${timeoutMs}ms）`, details: { timeoutMs } }
  } else if (outcome.spawnError !== undefined || outcome.code !== 0) {
    status = 'failed'
    diagnosis = {
      code: 'RUN_FAILED',
      message: outcome.spawnError?.message ?? `退出码 ${outcome.code ?? 'null'}`,
      details: { exitCode: outcome.code, signal: outcome.signal, stderrTail: truncate(stderr, 2_000) },
    }
  } else if (result !== null && typeof result === 'object' && (result as Record<string, unknown>).status === 'failed') {
    status = 'failed'
    diagnosis = { code: 'RUN_FAILED', message: '结果文件 status=failed', details: result }
  }

  return {
    status,
    exitCode: outcome.code,
    durationMs,
    stdout: truncate(stdout, maxChars),
    stderr: truncate(stderr, maxChars),
    ...(result === undefined ? {} : { result }),
    ...(resultPath === undefined ? {} : { resultPath }),
    artifacts,
    ...(diagnosis === undefined ? {} : { diagnosis }),
  }
}
