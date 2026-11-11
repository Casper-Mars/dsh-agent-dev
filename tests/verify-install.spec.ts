/**
 * `scripts/verify-install.mjs` 单测。
 *
 * 覆盖：默认检查**包内** `skills/`（未安装状态也全 PASS）、缺 SKILL.md / 缺
 * references / 空文件、`--assets` 手工路径、退出码 0 / 1 / 2、符号链接调用不
 * 静默 exit 0。夹具全部落在 `mkdtempSync` 临时目录，不读写真实 profile。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_CHECK_COUNT,
  EXPECTED_REFERENCE_STACKS,
  EXPECTED_SKILLS,
  exitCode,
  formatReport,
  main,
  resolveSkillsRoot,
  verifyInstall,
} from '../scripts/verify-install.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/verify-install.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoots: string[] = []

function writeFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

/** 完整夹具：18 个 SKILL.md + 5 个 references，模拟一份合格资产目录。 */
function makeFixture(): { root: string; skillsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'verify-install-'))
  temporaryRoots.push(root)
  const skillsRoot = join(root, 'skills')
  for (const name of EXPECTED_SKILLS) writeFile(join(skillsRoot, name, 'SKILL.md'), `# ${name}\n`)
  for (const stack of EXPECTED_REFERENCE_STACKS) {
    writeFile(join(skillsRoot, 'dev-test-strategy', 'references', `${stack}.md`), `# ${stack}\n`)
  }
  return { root, skillsRoot }
}

/** 报告里以 PASS / FAIL 开头的行（检查项行）。 */
const checkLines = (lines: string[]): string[] => lines.filter((line) => /^(PASS|FAIL)/.test(line))

const runCli = (args: string[], cwd = REPO_ROOT): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd })

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('期望常量', () => {
  it('13 个 Skill + 5 个 references = 18 项', () => {
    expect(EXPECTED_SKILLS).toHaveLength(13)
    expect(new Set(EXPECTED_SKILLS).size).toBe(13)
    expect(EXPECTED_REFERENCE_STACKS).toHaveLength(5)
    expect(EXPECTED_CHECK_COUNT).toBe(18)
  })
})

describe('verifyInstall（包内资产）', () => {
  it('默认检查包内 skills/：未安装状态下 18 条全 PASS、退出码 0', () => {
    const targets = resolveSkillsRoot({ repoRoot: REPO_ROOT })
    expect(targets.source).toBe('package')
    expect(targets.skillsRoot).toBe(join(REPO_ROOT, 'skills'))

    const result = verifyInstall(targets)
    expect([result.checks.length, result.passed, result.failed]).toEqual([18, 18, 0])
    expect(exitCode(result)).toBe(0)
    expect(result.source).toBe('package')

    const reports = checkLines(formatReport(result))
    expect(reports).toHaveLength(18)
    expect(reports.every((line) => line.startsWith('PASS'))).toBe(true)
  })

  it('完整夹具 → 18 条 PASS，kind / name 顺序与清单一致', () => {
    const fixture = makeFixture()
    const result = verifyInstall({ skillsRoot: fixture.skillsRoot })
    const actual = checkLines(formatReport(result)).map((line) => line.split(' ').slice(1, 3).join(':'))

    expect(actual).toEqual([
      ...EXPECTED_SKILLS.map((name: string) => `skill:${name}`),
      ...EXPECTED_REFERENCE_STACKS.map((stack: string) => `reference:${stack}`),
    ])
    expect(new Set(actual).size).toBe(actual.length)
    expect(exitCode(result)).toBe(0)
  })

  it('缺 1 个 SKILL.md → 1 条 FAIL（带路径）+ 17 条 PASS，退出码 1', () => {
    const fixture = makeFixture()
    const missing = join(fixture.skillsRoot, EXPECTED_SKILLS[0] as string, 'SKILL.md')
    rmSync(dirname(missing), { recursive: true, force: true })

    const result = verifyInstall({ skillsRoot: fixture.skillsRoot })
    const lines = checkLines(formatReport(result))
    const fails = lines.filter((line) => line.startsWith('FAIL'))

    expect(exitCode(result)).toBe(1)
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain(`skill ${EXPECTED_SKILLS[0]}`)
    expect(fails[0]).toContain(missing)
    expect(lines.filter((line) => line.startsWith('PASS'))).toHaveLength(17)
  })

  it('缺 1 个 reference → 1 条 FAIL', () => {
    const fixture = makeFixture()
    const missing = join(
      fixture.skillsRoot,
      'dev-test-strategy',
      'references',
      `${EXPECTED_REFERENCE_STACKS[0] as string}.md`,
    )
    rmSync(missing)

    const result = verifyInstall({ skillsRoot: fixture.skillsRoot })
    const fails = checkLines(formatReport(result)).filter((line) => line.startsWith('FAIL'))
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain(`reference ${EXPECTED_REFERENCE_STACKS[0]}`)
    expect(fails[0]).toContain(missing)
  })

  it('空文件 → FAIL 原因为「文件为空」', () => {
    const fixture = makeFixture()
    const empty = join(fixture.skillsRoot, EXPECTED_SKILLS[1] as string, 'SKILL.md')
    writeFileSync(empty, '', 'utf8')

    const result = verifyInstall({ skillsRoot: fixture.skillsRoot })
    const fail = checkLines(formatReport(result)).find((line) => line.startsWith('FAIL'))
    expect(fail).toContain('文件为空')
    expect(fail).toContain(empty)
    expect(exitCode(result)).toBe(1)
  })

  it('skillsRoot 为空字符串 → TypeError（调用方错误）', () => {
    expect(() => verifyInstall({ skillsRoot: '' })).toThrowError(TypeError)
  })
})

describe('resolveSkillsRoot', () => {
  it('默认 = <repoRoot>/skills；--assets 相对 cwd 解析', () => {
    expect(resolveSkillsRoot({ repoRoot: '/repo/root' })).toEqual({
      skillsRoot: '/repo/root/skills',
      source: 'package',
    })
    expect(resolveSkillsRoot({ assets: 'legacy/assets', repoRoot: '/repo/root', cwd: '/cwd' })).toEqual({
      skillsRoot: '/cwd/legacy/assets',
      source: 'assets',
    })
    expect(resolveSkillsRoot({ assets: '/abs/assets', repoRoot: '/repo/root' })).toEqual({
      skillsRoot: '/abs/assets',
      source: 'assets',
    })
  })
})

describe('CLI 退出码', () => {
  it('默认路径 → exit 0，18 条 PASS，无 FAIL', () => {
    const child = runCli([])
    const lines = checkLines(child.stdout.split('\n'))
    expect(child.status).toBe(0)
    expect(lines).toHaveLength(18)
    expect(lines.every((line) => line.startsWith('PASS'))).toBe(true)
    expect(child.stdout).not.toMatch(/^FAIL/m)
  })

  it('--assets 指向完整夹具 → exit 0，报告标注手工核查', () => {
    const fixture = makeFixture()
    const child = runCli(['--assets', fixture.skillsRoot])
    const lines = checkLines(child.stdout.split('\n'))
    expect(child.status).toBe(0)
    expect(lines).toHaveLength(18)
    expect(child.stdout).toContain('手工资产目录核查')
    expect(child.stdout).toContain(fixture.skillsRoot)
  })

  it('--assets 指向不完整目录 → exit 1，FAIL 行带原因', () => {
    const fixture = makeFixture()
    rmSync(join(fixture.skillsRoot, EXPECTED_SKILLS[2] as string), { recursive: true, force: true })
    const child = runCli(['--assets', fixture.skillsRoot])
    expect(child.status).toBe(1)
    expect(child.stdout).toMatch(/^FAIL skill /m)
  })

  it.each([
    ['--assets 指向不存在目录', (missing: string) => ['--assets', missing], '不存在'],
    ['未知参数', () => ['--home', '/tmp'], '未知参数'],
    ['--assets 缺少取值', () => ['--assets'], '缺少取值'],
  ])('%s → exit 2，无 PASS/FAIL 行、无堆栈', (_label, argsOf, expected) => {
    const missing = join(makeFixture().root, 'does-not-exist')
    const child = runCli((argsOf as (path: string) => string[])(missing))
    expect(child.status).toBe(2)
    expect(child.stderr).toContain(expected)
    expect(child.stderr).not.toMatch(/\n\s+at /)
    expect(child.stdout).not.toMatch(/^(PASS|FAIL)/m)
  })

  it('main() 纯函数调用：参数错误返回 2，不退出进程', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(main(['--nope'])).toBe(2)
      expect(main(['--assets', join(makeFixture().root, 'nope')])).toBe(2)
      expect(main([])).toBe(0)
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('经符号链接调用 → 仍跑满 18 项 PASS，不静默 exit 0', () => {
    const link = join(makeFixture().root, 'verify-link.mjs')
    symlinkSync(SCRIPT, link)
    const child = spawnSync(process.execPath, [link], { encoding: 'utf8', cwd: REPO_ROOT })
    const lines = checkLines(child.stdout.split('\n'))
    expect([child.status, child.stdout.length > 0, lines.length]).toEqual([0, true, 18])
    expect(lines.every((line) => line.startsWith('PASS'))).toBe(true)
  })
})
