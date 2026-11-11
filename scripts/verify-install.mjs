/**
 * 包内资产自检（`pnpm verify:install`）：确认本包 `skills/` 下 8 个领域 Skill 的
 * `SKILL.md` 与 `dev-test-strategy/references/` 的 5 个栈文档齐全且非空。
 *
 * 检查目标是**包内**资产，与是否安装到 profile 无关：未安装状态下也必须全 PASS。
 * 旧版的「安装目录」硬编码与 `--home` / 环境变量默认推导已随任务-05 删除；
 * `--assets <dir>` 只用于手工核查旧资产目录，不再是默认路径。
 *
 * 退出码：全 PASS 为 0，有 FAIL 为 1，参数 / 环境错误（目录不存在、未知参数）为 2。
 * 核心逻辑均为导出纯函数，`main` 仅在直接执行本文件时运行；导入本模块不跑 main、
 * 不 `process.exit`，便于单测直接调用。
 */
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 期望的 13 个领域 Skill（与 `src/domain.ts` 的 DEV_DOMAIN.skills 一致）。 */
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

/** `dev-test-strategy/references/` 下期望的 5 个栈文档（文件名去掉 `.md`）。 */
export const EXPECTED_REFERENCE_STACKS = ['go', 'harmony-arkts', 'node-ts', 'python', 'react']

/** 检查项总数：13 个 SKILL.md + 5 个 references。 */
export const EXPECTED_CHECK_COUNT = EXPECTED_SKILLS.length + EXPECTED_REFERENCE_STACKS.length

/** 目录存在性判断（环境错误 → 退出码 2 用）。 */
const isDir = (target) => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

const describeError = (error) => (error instanceof Error ? error.message : String(error))

/** 校验一个「必须存在、是普通文件、非空」的文件，返回单个检查项。 */
function check(kind, name, file) {
  let reason = '缺少文件'
  try {
    const info = statSync(file)
    reason = info.isFile() ? (info.size === 0 ? '文件为空' : '') : '不是普通文件'
  } catch {
    /* 缺失即 FAIL，reason 用于定位 */
  }
  return { kind, name, path: file, ok: reason === '', reason }
}

/**
 * 执行 13 项自检（8 个 Skill + 5 个 references），不抛错、不写盘。
 *
 * @param {{ skillsRoot: string, source?: 'package' | 'assets' }} targets
 * @returns {{ skillsRoot: string, source: string, checks: object[], passed: number, failed: number, ok: boolean }}
 */
export function verifyInstall({ skillsRoot, source = 'package' }) {
  if (typeof skillsRoot !== 'string' || skillsRoot === '') {
    throw new TypeError('verifyInstall 需要非空的 skillsRoot')
  }
  const checks = [
    ...EXPECTED_SKILLS.map((name) => check('skill', name, path.join(skillsRoot, name, 'SKILL.md'))),
    ...EXPECTED_REFERENCE_STACKS.map((stack) =>
      check('reference', stack, path.join(skillsRoot, 'dev-test-strategy', 'references', `${stack}.md`)),
    ),
  ]
  const passed = checks.filter((item) => item.ok).length
  return {
    skillsRoot,
    source,
    checks,
    passed,
    failed: checks.length - passed,
    ok: passed === checks.length,
  }
}

/** 报告 → 文本行：`PASS` / `FAIL` 行只对应检查项（恰好 13 条），其余以 `#` 开头，便于 grep 计数。 */
export function formatReport(result) {
  const lines = [`# verify-install：skills=${result.skillsRoot} 来源=${result.source}`]
  if (result.source === 'assets') {
    lines.push(`# 手工资产目录核查（--assets）：${result.skillsRoot}`)
  }
  for (const item of result.checks) {
    lines.push(
      item.ok
        ? `PASS ${item.kind} ${item.name} ${item.path}`
        : `FAIL ${item.kind} ${item.name} ${item.reason}：${item.path}`,
    )
  }
  lines.push(`# 结果：${result.passed}/${result.checks.length} 通过，退出码 ${exitCode(result)}`)
  return lines
}

/** 报告 → 退出码：全 PASS 为 0，有 FAIL 为 1（参数 / 环境错误由 CLI 返回 2）。 */
export function exitCode(result) {
  return result.ok ? 0 : 1
}

/**
 * 解析待检查的 skills 根目录（只推导路径、不检查存在性）。
 *
 * 默认 = `<包根>/skills`；`--assets <dir>` 时 = `<cwd>/<dir>`（手工核查用）。
 */
export function resolveSkillsRoot({ assets, repoRoot, cwd = process.cwd() }) {
  if (assets) return { skillsRoot: path.resolve(cwd, assets), source: 'assets' }
  return { skillsRoot: path.join(repoRoot, 'skills'), source: 'package' }
}

/** 解析命令行参数（仅支持 `--assets <dir>`）；非法参数抛错，由 main 转成退出码 2。 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--assets') throw new Error(`未知参数 "${flag}"（可用：--assets <dir>）`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 "${flag}" 缺少取值`)
    options.assets = value
    index += 1
  }
  return options
}

/** CLI 主流程：解析参数 → 定位 skills 根 → 校验 → 打印报告。环境错误只输出一行（无堆栈）。 */
export function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[verify-install] ${describeError(error)}`)
    return 2
  }

  const targets = resolveSkillsRoot({ ...options, repoRoot })
  if (!isDir(targets.skillsRoot)) {
    const label = targets.source === 'assets' ? '--assets 指定的目录' : '包内 skills 目录'
    console.error(`[verify-install] ${label}不存在：${targets.skillsRoot}`)
    return 2
  }

  try {
    const result = verifyInstall(targets)
    for (const line of formatReport(result)) console.log(line)
    return exitCode(result)
  } catch (error) {
    console.error(`[verify-install] 自检异常：${describeError(error)}`)
    return 2
  }
}

/**
 * CLI 入口守卫：`argv[1]` 可能经符号链接（`/tmp`、挂载盘），而 `import.meta.url` 已是
 * realpath，必须比较 realpath，否则会「没跑 main 却 exit 0」（静默假绿）；
 * realpath 失败退回 inode / 字符串比较。
 */
function isDirectRun() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(invoked) === realpathSync(self)
  } catch {
    try {
      const [a, b] = [statSync(invoked), statSync(self)]
      return a.dev === b.dev && a.ino === b.ino
    } catch {
      return path.resolve(invoked) === path.resolve(self)
    }
  }
}

if (isDirectRun()) process.exitCode = main(process.argv.slice(2))
