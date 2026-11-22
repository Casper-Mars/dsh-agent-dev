/**
 * `asset` 工具：资产飞轮的唯一 agent 入口。
 *
 * 六个 action 共用一套 schema，工具面只 +1：
 * - search：按 tags 检索项目 L2 + 共享 L1/L0；
 * - create：在 staging 建 L3 脚手架；
 * - run：执行已注册资产（支持 smoke / timeout / cancel）；
 * - settle：L3 结算（propose-l2 / promote-l2 / propose-l1 / discard / debt）；
 * - finalize：清点 staging，返回标准 `## 资产` 块；
 * - audit：全量审计；带 id 时做单资产诊断。
 *
 * 只返回事实（路径、状态、错误码），不返回“下一步建议”；工作流由
 * `asset-first` skill 与 persona 负责。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  AssetError,
  auditAssets,
  createStagingAsset,
  diagnoseAsset,
  loadSnapshot,
  runAsset,
  searchAssets,
  settleStagingAsset,
  appendUsage,
  assetBlock,
  finalizeLedger,
  markCreated,
  markSettled,
  markUsed,
  readLedger,
  recordAction,
  updateTrust,
  usageCounts,
  searchLocalAssets,
  findLocalAsset,
  type RegistrySnapshot,
} from '../asset/index.js'

export const name = 'tool-asset'
export const inject = ['tools']

export interface AssetToolConfig {
  /** 共享资产库根：容器内通常是 /opt/agent-assets。 */
  libraryRoot?: string
  /** 项目根；缺省从 agent session header 的 cwd 取，再退回 process.cwd()。 */
  projectRoot?: string
  /** 跨任务状态根：ledger / usage / trust / debt 的父目录。 */
  stateRoot?: string
  /** debt 存放根；缺省 <stateRoot>/debt。 */
  debtRoot?: string
  /** 单任务 run 上限，默认 3。 */
  maxRunsPerTask?: number
  /** 单任务 create 上限，默认 1。 */
  maxCreatesPerTask?: number
}


interface AgentLike {
  session?: { header?: { cwd?: unknown } }
}

interface ToolExecLike extends Pick<ToolRunContext, 'signal'> {
  agent?: AgentLike | null
}

function projectRootOf(_exec: ToolExecLike, config: AssetToolConfig, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  if (config.projectRoot !== undefined && config.projectRoot.trim() !== '') return config.projectRoot
  throw new AssetError(
    'INVALID_MANIFEST',
    'project_root 必填：传当前任务 worktree 的项目根（不要依赖 session cwd，/workspace 不是项目根）',
  )
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 归一化为纯 JSON：去掉 undefined，保证 output.schema 的 type=json 可校验。 */
function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function tail(text: string, max = 4_000): string {
  if (text.length <= max) return text
  return `${text.slice(-max)}\n…（仅保留尾部 ${max} 字符，原长 ${text.length}）`
}

function summarizeSnapshot(snapshot: RegistrySnapshot): Record<string, unknown> {
  return {
    library_version: snapshot.libraryVersion ?? null,
    project_assets_root: snapshot.projectAssetsRoot,
    issues: snapshot.issues,
  }
}

function errorResult(action: string, error: unknown): { action: string; ok: false; error: { code: string; message: string } } {
  if (error instanceof AssetError) {
    return { action, ok: false, error: { code: error.code, message: error.message } }
  }
  throw error
}

export function buildAssetTool(config: AssetToolConfig = {}): ToolDefinition {
  return defineTool({
    name: 'asset',
    description: [
      '资产工具：search 检索项目/共享库资产；create 在 staging 建 L3 脚手架；run 执行已注册资产；settle 结算 L3；finalize 清点并返回 ## 资产 块；audit 审计/诊断。',
      '只返回事实（id、路径、状态、错误码），不返回下一步建议。',
      'search 按 tags 匹配（所有 tag 都要命中）；run 必须传 id + scenario，或 smoke=true；create 必须传 name/purpose/task_id。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'create', 'run', 'settle', 'finalize', 'audit'],
        description: '要执行的动作。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'search 用：所有 tag 都命中的资产才会返回。',
      },
      id: {
        type: 'string',
        description: 'run / audit 用：资产 id；settle 时可代替 name。',
      },
      name: {
        type: 'string',
        description: 'create / settle 用：资产名（小写字母/数字/连字符）。',
      },
      task_id: {
        type: 'string',
        description: 'create / run / settle / finalize / audit 用：当前任务号；ledger 与预算按它统计。',
      },
      purpose: {
        type: 'string',
        description: 'create 用：一句话说明资产用途。',
      },
      layer: {
        type: 'string',
        enum: ['L2', 'L3'],
        description: 'create 用：L3 是 staging，L2 是项目场景包。',
      },
      inputs: {
        type: 'array',
        items: { type: 'string' },
        description: 'create 用：输入文件/参数清单。',
      },
      outputs: {
        type: 'array',
        items: { type: 'string' },
        description: 'create 用：输出文件清单。',
      },
      reuse_expect: {
        type: 'integer',
        description: 'create / settle 用：预期复用次数。',
      },
      owner: {
        type: 'string',
        description: 'create / settle 用：资产 owner。',
      },
      scenario: {
        type: 'string',
        description: 'run 用：场景 JSON 路径（相对项目根或绝对路径，必须在项目/资产根内）。',
      },
      smoke: {
        type: 'boolean',
        description: 'run 用：true 时执行 test/smoke.sh，不执行 scenario。',
      },
      timeout_ms: {
        type: 'integer',
        description: 'run 用：超时毫秒，默认 120000，上限 600000。',
      },
      decision: {
        type: 'string',
        enum: ['promote-l2', 'propose-l2', 'propose-l1', 'discard', 'debt'],
        description: 'settle 用：结算方式。',
      },
      reason: {
        type: 'string',
        description: 'settle 用：discard / debt / propose-l1 的原因。',
      },
      force: {
        type: 'boolean',
        description: 'settle 用：目标已存在时是否覆盖。',
      },
      project_root: {
        type: 'string',
        description: '必填：当前任务 worktree 的项目根（绝对路径）；不要传 /workspace。',
      },
      scenario_root: {
        type: 'string',
        description: 'run 用：场景根（例如 tester 的验证副本）；缺省等于 project_root。',
      },
      allow_repo_write: {
        type: 'boolean',
        description: 'settle promote-l2 用：确认会写入项目仓库；缺省 false，直接拒绝。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          data: { type: 'json' },
          error: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = args.action
      const libraryRoot = config.libraryRoot
      try {
        const projectRoot = projectRootOf(exec as ToolExecLike, config, args.project_root)
        const taskId = args.task_id?.trim() ?? ''
        const ledgerLocation = { ...(config.stateRoot === undefined ? {} : { stateRoot: config.stateRoot }), projectRoot }
        if (action === 'search') {
          const snapshot = loadSnapshot({ projectRoot, ...(libraryRoot === undefined ? {} : { libraryRoot }) })
          const usage = usageCounts(ledgerLocation)
          const localItems = searchLocalAssets({
            projectRoot,
            ...(config.stateRoot === undefined ? {} : { stateRoot: config.stateRoot }),
            tags: args.tags,
          }).map(asset => ({
            id: asset.id,
            layer: asset.layer,
            source: asset.source,
            version: null,
            health: asset.health,
            last_verified: null,
            usage_count: 0,
            tags: asset.tags,
            known_limits: [],
            purpose: asset.purpose ?? null,
            entry: asset.entry,
            path: asset.path,
          }))
          const items = searchAssets(snapshot, { tags: args.tags }).map(asset => ({
            id: asset.id,
            layer: asset.layer,
            source: asset.source,
            version: asset.version ?? null,
            health: asset.health,
            last_verified: asset.lastVerified ?? null,
            usage_count: usage.get(asset.id) ?? asset.usageCount ?? 0,
            tags: asset.tags ?? [],
            known_limits: asset.knownLimits ?? [],
            purpose: asset.purpose ?? null,
            entry: asset.entry,
          }))
          return { action, ok: true, data: asJson({ items: [...items, ...localItems], ...summarizeSnapshot(snapshot) }) }
        }

        if (action === 'create') {
          if (args.task_id === undefined || args.task_id.trim() === '') {
            throw new AssetError('INVALID_MANIFEST', 'create 需要 task_id')
          }
          if ((args.name ?? args.id) === undefined) {
            throw new AssetError('INVALID_MANIFEST', 'create 需要 name 或 id')
          }
          if (args.purpose === undefined || args.purpose.trim() === '') {
            throw new AssetError('INVALID_MANIFEST', 'create 需要 purpose')
          }
          if (args.layer === 'L2') {
            throw new AssetError('INVALID_MANIFEST', 'create 只支持 L3；L2 由 settle propose-l2 产生')
          }
          const existing = findLocalAsset({
            projectRoot,
            ...(config.stateRoot === undefined ? {} : { stateRoot: config.stateRoot }),
            name: args.name ?? args.id ?? '',
          })
          if (existing !== undefined) {
            throw new AssetError('SETTLE_CONFLICT', `同名资产已存在（${existing.health}）：${existing.path}；先 search/settle，不要重复 create`)
          }
          const ledger = readLedger(ledgerLocation, args.task_id)
          if (ledger.actions.create >= (config.maxCreatesPerTask ?? 1)) {
            throw new AssetError('BUDGET_EXCEEDED', `本任务 create 已达上限 ${config.maxCreatesPerTask ?? 1}`)
          }
          const created = createStagingAsset({
            projectRoot,
            taskId: args.task_id ?? '',
            name: args.name ?? args.id ?? '',
            purpose: args.purpose ?? '',
            ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
            ...(args.outputs === undefined ? {} : { outputs: args.outputs }),
            ...(args.owner === undefined ? {} : { owner: args.owner }),
            ...(args.reuse_expect === undefined ? {} : { reuseExpect: args.reuse_expect }),
          })
          const name = args.name ?? args.id ?? ''
          markCreated(ledgerLocation, args.task_id, name)
          return { action, ok: true, data: asJson({ staging_path: created.stagingPath, files: created.files }) }
        }

        if (action === 'run') {
          if (args.id === undefined) throw new AssetError('INVALID_MANIFEST', 'run 需要 id')
          if (taskId !== '') {
            const ledger = readLedger(ledgerLocation, taskId)
            if (ledger.actions.run >= (config.maxRunsPerTask ?? 3)) {
              throw new AssetError('BUDGET_EXCEEDED', `本任务 run 已达上限 ${config.maxRunsPerTask ?? 3}`)
            }
          }
          const result = await runAsset({
            projectRoot,
            ...(libraryRoot === undefined ? {} : { libraryRoot }),
            id: args.id,
            ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
            ...(args.scenario_root === undefined ? {} : { scenarioRoot: args.scenario_root }),
            ...(args.smoke === undefined ? {} : { smoke: args.smoke }),
            ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
            signal: exec.signal,
          })
          if (taskId !== '') {
            recordAction(ledgerLocation, taskId, 'run')
            appendUsage(ledgerLocation, {
              ts: new Date().toISOString(),
              taskId,
              assetId: args.id,
              status: result.status,
              durationMs: result.durationMs,
              source: 'library',
            })
            if (result.status === 'passed') markUsed(ledgerLocation, taskId, args.id)
            const today = new Date().toISOString().slice(0, 10)
            updateTrust(ledgerLocation, args.id, {
              lastUsed: today,
              ...(args.smoke === true && result.status === 'passed' ? { lastVerified: today } : {}),
            })
          }
          return {
            action,
            ok: result.status === 'passed',
            data: asJson({
              status: result.status,
              exit_code: result.exitCode,
              duration_ms: result.durationMs,
              result_path: result.resultPath ?? null,
              artifacts: result.artifacts,
              diagnosis: result.diagnosis ?? null,
              stdout_tail: tail(result.stdout),
              stderr_tail: tail(result.stderr),
            }),
          }
        }

        if (action === 'finalize') {
          if (taskId === '') throw new AssetError('INVALID_MANIFEST', 'finalize 需要 task_id')
          const ledger = finalizeLedger(ledgerLocation, taskId, projectRoot)
          return { action, ok: true, data: asJson({ asset_block: assetBlock(ledger), ledger }) }
        }

        if (action === 'settle') {
          const target = args.id ?? args.name
          if (target === undefined) throw new AssetError('INVALID_MANIFEST', 'settle 需要 id 或 name')
          if (args.decision === undefined) throw new AssetError('INVALID_MANIFEST', 'settle 需要 decision')
          const result = settleStagingAsset({
            projectRoot,
            name: target,
            decision: args.decision,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
            ...(args.owner === undefined ? {} : { owner: args.owner }),
            ...(args.reuse_expect === undefined ? {} : { reuseExpect: args.reuse_expect }),
            ...(args.force === undefined ? {} : { force: args.force }),
            ...(args.allow_repo_write === undefined ? {} : { allowRepoWrite: args.allow_repo_write }),
            ...(config.debtRoot === undefined ? {} : { debtRoot: config.debtRoot }),
          })
          if (taskId !== '') markSettled(ledgerLocation, taskId, target, args.decision)
          return {
            action,
            ok: true,
            data: asJson({
              status: result.status,
              target_path: result.targetPath ?? null,
              registry_updated: result.registryUpdated,
              promotion_bundle: result.promotionBundle ?? null,
            }),
          }
        }

        // audit
        if ((action as string) !== 'audit') {
          throw new AssetError('INVALID_MANIFEST', `未知 action：${String(action)}`)
        }
        if (args.id !== undefined) {
          const diagnosis = diagnoseAsset({ projectRoot, ...(libraryRoot === undefined ? {} : { libraryRoot }), id: args.id })
          return { action, ok: true, data: asJson(diagnosis) }
        }
        const report = auditAssets({
          projectRoot,
          ...(libraryRoot === undefined ? {} : { libraryRoot }),
          usageCounts: usageCounts(ledgerLocation),
        })
        return { action, ok: true, data: asJson(report) }
      } catch (error) {
        return errorResult(action, error)
      }
    },
  })
}

/** Cordis 装配入口：把 `asset` 注册进当前 preset 的工具面。 */
export function apply(ctx: Context, config: AssetToolConfig = {}): void {
  ctx.tools.register(buildAssetTool(config))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = (exec as { args?: Record<string, unknown> }).args
    // 只拦“交付报告”形状，不认 kit 的工具名；bash/write/read 等实现工具照常放行。
    if (args === undefined || typeof args.summary_md !== 'string' || typeof args.task_id !== 'string') return next()
    const ledger = readLedger({
      ...(config.stateRoot === undefined ? {} : { stateRoot: config.stateRoot }),
      projectRoot: config.projectRoot ?? '/workspace',
    }, args.task_id)
    if (ledger.pending.length > 0 || ledger.finalized !== true) {
      const detail = ledger.pending.length > 0 ? `staging 未结算：${ledger.pending.join('、')}` : '未调用 asset finalize'
      return { kind: 'deny', reason: `交付报告被拦：${detail}；先 asset finalize` }
    }
    return next()
  }, { prepend: true })
}
