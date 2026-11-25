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

/** 期望随包注册的 15 个领域 Skill（真源是 `scripts/verify-install.mjs`，由单测对齐）。 */
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
  'dev-ui-review',
  'dev-ui-verify',
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

  // dsh 对插件加载失败是「记录错误 + 继续启动」，不会让 runProfile 抛错。
  // 只断言 skills / preset roster 会漏掉「某个工具 never started」这种半启动状态，
  // 所以这里同时捕获启动期的插件加载错误，作为第四层闸门。
  const startupErrors = []
  const startupErrorPatterns = [
    /never started/i,
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    /Cannot find package/i,
    /does not provide an export/i,
  ]
  const originalError = console.error
  const originalWarn = console.warn
  const captureStartupError = (...args) => {
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
    if (startupErrorPatterns.some((pattern) => pattern.test(line))) startupErrors.push(line)
  }
  console.error = (...args) => {
    captureStartupError(...args)
    originalError(...args)
  }
  console.warn = (...args) => {
    captureStartupError(...args)
    originalWarn(...args)
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
    console.error = originalError
    console.warn = originalWarn
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`FAIL profile "${profile}" 冷启动失败：${detail}`)
    process.exit(1)
  }

  console.error = originalError
  console.warn = originalWarn

  try {
    if (startupErrors.length > 0) {
      fail(`启动期有 ${startupErrors.length} 条插件加载错误：${startupErrors[0].slice(0, 240)}`)
    } else {
      pass('启动期无插件加载错误')
    }

    const skills = ctx.get('skills')
    if (skills === undefined || typeof skills.list !== 'function' || typeof skills.get !== 'function') {
      fail('ctx.skills 缺失或缺少 list()/get()：dsh-skill 服务契约可能已变更')
    } else {
      // 领域 Skill 在各自 preset 层，宿主层读不到；这里只确认服务契约可用。
      const list = await skills.list()
      if (Array.isArray(list)) pass('skills.list() 契约可用（领域 Skill 在 preset 层注册）')
      else fail('skills.list() 未返回数组')
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

      // roster 若带插件列表，就验证每个 preset 都声明了自己的资产插件。
      const assets = { 'dev-leader': 'dsh-agent-dev/assets/leader', 'dev-developer': 'dsh-agent-dev/assets/developer', 'dev-tester': 'dsh-agent-dev/assets/tester' }
      for (const [presetId, moduleName] of Object.entries(assets)) {
        const own = roster.find((item) => (item.id ?? item.config?.id) === presetId)
        const declared = own?.plugins ?? own?.config?.plugins
        if (!Array.isArray(declared)) continue
        if (declared.some((entry) => String(entry?.name ?? '').includes(moduleName))) pass(`${presetId} 声明了 ${moduleName}`)
        else fail(`${presetId} 未声明 ${moduleName}：该 preset 的技能不会进 preset 层`)
      }
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
