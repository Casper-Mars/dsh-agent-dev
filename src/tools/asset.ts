/**
 * `asset` 工具：资产飞轮的唯一 agent 入口。
 *
 * 五个 action 共用一套 schema，工具面只 +1：
 * - search：按 tags 检索项目 L2 + 共享 L1/L0；
 * - create：在 staging 建 L3 脚手架；
 * - run：执行已注册资产（支持 smoke / timeout / cancel）；
 * - settle：L3 结算（promote-l2 / propose-l1 / discard / debt）；
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
  type RegistrySnapshot,
} from '../asset/index.js'

export const name = 'tool-asset'
export const inject = ['tools']

export interface AssetToolConfig {
  /** 共享资产库根：容器内通常是 /opt/agent-assets。 */
  libraryRoot?: string
  /** 项目根；缺省从 agent session header 的 cwd 取，再退回 process.cwd()。 */
  projectRoot?: string
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
      '资产工具：search 检索项目/共享库资产；create 在 staging 建 L3 脚手架；run 执行已注册资产；settle 结算 L3；audit 审计/诊断。',
      '只返回事实（id、路径、状态、错误码），不返回下一步建议。',
      'search 按 tags 匹配（所有 tag 都要命中）；run 必须传 id + scenario，或 smoke=true；create 必须传 name/purpose/task_id。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'create', 'run', 'settle', 'audit'],
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
        description: 'create 用：当前任务号，决定 staging/<task-id>/ 目录。',
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
        enum: ['promote-l2', 'propose-l1', 'discard', 'debt'],
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
        if (action === 'search') {
          const snapshot = loadSnapshot({ projectRoot, ...(libraryRoot === undefined ? {} : { libraryRoot }) })
          const items = searchAssets(snapshot, { tags: args.tags }).map(asset => ({
            id: asset.id,
            layer: asset.layer,
            source: asset.source,
            version: asset.version ?? null,
            health: asset.health,
            last_verified: asset.lastVerified ?? null,
            tags: asset.tags ?? [],
            known_limits: asset.knownLimits ?? [],
            purpose: asset.purpose ?? null,
            entry: asset.entry,
          }))
          return { action, ok: true, data: asJson({ items, ...summarizeSnapshot(snapshot) }) }
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
            throw new AssetError('INVALID_MANIFEST', 'create 只支持 L3；L2 由 settle promote-l2 产生')
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
          return { action, ok: true, data: asJson({ staging_path: created.stagingPath, files: created.files }) }
        }

        if (action === 'run') {
          if (args.id === undefined) throw new AssetError('INVALID_MANIFEST', 'run 需要 id')
          const result = await runAsset({
            projectRoot,
            ...(libraryRoot === undefined ? {} : { libraryRoot }),
            id: args.id,
            ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
            ...(args.smoke === undefined ? {} : { smoke: args.smoke }),
            ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
            signal: exec.signal,
          })
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
          })
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
        const report = auditAssets({ projectRoot, ...(libraryRoot === undefined ? {} : { libraryRoot }) })
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
}
