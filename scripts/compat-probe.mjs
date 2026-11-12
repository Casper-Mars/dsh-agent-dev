/**
 * 运行时兼容探针：在**真的装上本包**的 dsh profile 上冷启动一次，断言领域装配生效。
 *
 * `dsh --dump-config` 只证明 patch 能被组合出来，不证明插件 `apply()` 能跑通：
 * Skill 注册、preset roster、模块解析都是挂载期才发生的。本探针补上这一段，
 * 是 `scripts/dsh-compat.sh` 的第二道闸门。
 *
 * 用法（由 dsh-compat.sh 调用，必须从 dsh 安装目录运行，裸导入才能解析）：
 *
 *   DSH_HOME=<临时目录> PROBE_PROFILE=compat node compat-probe.mjs
 *
 * 退出码：全 PASS 为 0，任一断言失败为 1，启动失败 / 超时为 1。
 *
 * 本文件同时被 `tests/compat-probe.spec.ts` 导入做静态一致性检查，因此顶层
 * 不得有副作用：只有直接执行（argv[1] === 本文件）时才跑探针主体。
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** 期望随包注册的 13 个领域 Skill（真源是 `scripts/verify-install.mjs`，由单测对齐）。 */
export const EXPECTED_SKILLS = [
  'dev-environment',
  'dev-dispatch-contract',
  'dev-quality-gate',
  'dev-worktree-git',
  'dev-test-strategy',
  'dev-role-developer',
  'dev-role-tester',
  'dev-implementation-plan',
  'dev-code-review',
  'dev-systematic-debugging',
  'dev-release',
  'dev-observability',
  'dev-retro',
]

/** 期望注册的 3 个 agent preset。 */
export const EXPECTED_PRESETS = ['dev-leader', 'dev-developer', 'dev-tester']

/** 主会话默认 preset（`agent-preset-registry.default`）。 */
export const EXPECTED_DEFAULT_PRESET = 'dev-leader'

/** 探针硬超时：冷启动挂死时不能拖住 CI。 */
const DEFAULT_TIMEOUT_MS = 90_000

/** 探针主体。只在直接执行时调用。 */
async function main() {
  const profile = process.env.PROBE_PROFILE ?? 'ci'
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const failures = []

  const pass = (message) => console.log(`PASS ${message}`)
  const fail = (message) => {
    failures.push(message)
    console.log(`FAIL ${message}`)
  }

  const timer = setTimeout(() => {
    console.error(`FAIL 冷启动超时（${timeoutMs}ms）：profile "${profile}" 未在限定时间内完成挂载`)
    process.exit(1)
  }, timeoutMs)

  // `@deepseek-ai/dsh` 的 exports 暴露了 `./lib/*`，profile-boot 是官方启动入口。
  const { runProfile } = await import('@deepseek-ai/dsh/lib/profile-boot.js')

  // 启动器要求「带 value 的 env 视图」，直接传 process.env 会在 http-proxy 处崩。
  const environment = new Map(Object.entries(process.env).map(([key, value]) => [key, { value }]))

  let ctx
  let shutdown
  try {
    ;({ ctx, shutdown } = await runProfile({ environment, profile, patchFiles: [], args: [] }))
  } catch (error) {
    clearTimeout(timer)
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`FAIL profile "${profile}" 冷启动失败：${detail}`)
    process.exit(1)
  }

  try {
    const skills = ctx.get('skills')
    if (skills === undefined || typeof skills.list !== 'function') {
      fail('ctx.skills 缺失或不支持 list()：dsh-skill 服务契约可能已变更')
    } else {
      const list = await skills.list()
      const names = new Set(list.map((item) => item.name))
      const missing = EXPECTED_SKILLS.filter((name) => !names.has(name))
      if (missing.length === 0) pass(`${EXPECTED_SKILLS.length} 个领域 Skill 全部可见`)
      else fail(`缺少领域 Skill：${missing.join('、')}`)

      const definition = await skills.get('dev-quality-gate')
      if (definition !== undefined && typeof definition.content === 'string' && definition.content.length > 0) {
        pass('skills.get("dev-quality-gate") 返回正文')
      } else {
        fail('skills.get("dev-quality-gate") 未返回正文')
      }
    }

    const presets = ctx.get('agentPresets')
    if (presets === undefined || typeof presets.list !== 'function') {
      fail('ctx.agentPresets 缺失或不支持 list()：preset 契约可能已变更')
    } else {
      const roster = await presets.list()
      const ids = new Set(roster.map((item) => item.id ?? item.config?.id))
      const missing = EXPECTED_PRESETS.filter((id) => !ids.has(id))
      if (missing.length === 0) pass('3 个 agent preset 均已注册')
      else fail(`缺少 preset：${missing.join('、')}`)

      const defaultId = presets.defaultId
      if (defaultId === EXPECTED_DEFAULT_PRESET) pass(`主会话默认 preset = ${defaultId}`)
      else fail(`主会话默认 preset 是 "${String(defaultId)}"，期望 "${EXPECTED_DEFAULT_PRESET}"`)
    }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    fail(`探针断言抛错：${detail}`)
  } finally {
    clearTimeout(timer)
    try {
      await shutdown?.shutdown(failures.length === 0 ? 0 : 1)
    } catch {
      // 关停失败不覆盖断言结论
    }
  }

  if (failures.length > 0) {
    console.error(`\n兼容探针失败：${failures.length} 项断言未通过`)
    process.exit(1)
  }
  console.log('\n运行时探针全部通过')
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
