/**
 * `dev` 领域数据（`src/domain.ts` + `src/persona.ts`）的纯逻辑契约。
 *
 * 原 `tests/pack.spec.ts` 的被测对象 `src/pack.ts` / `src/seeds.ts` 已删除，
 * 其中有价值的声明侧断言（Skill 名称集合、frontmatter 一致性、references 清单、
 * Leader 人设）迁到这里，不再依赖旧核心包或真实 core。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEV_DOMAIN } from '../src/domain'
import { parseFirmwareSkillMarkdown } from '../src/firmware'
import { LEADER_PERSONA } from '../src/persona'

/** 包根：源码态 `tests/` 的上一级。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills')
const REFERENCES_ROOT = path.join(SKILLS_ROOT, 'dev-test-strategy', 'references')

/** 期望的 8 个 Skill（顺序与 `DEV_DOMAIN.skills` 的稳定声明顺序一致）。 */
const EXPECTED_SKILL_NAMES = [
  'dev-environment',
  'dev-dispatch-contract',
  'dev-quality-gate',
  'dev-worktree-git',
  'dev-test-strategy',
  'dev-role-developer',
  'dev-role-tester',
  'dev-retro',
]

/** 期望的 5 个栈文档。 */
const EXPECTED_REFERENCE_STACKS = ['go', 'harmony-arkts', 'node-ts', 'python', 'react']

/** 上游 core 的保留 Skill 名：领域 Skill 不得占用。 */
const CORE_RESERVED_SKILLS = ['rsi-evolution', 'skill-authorship', 'task-authorship']

/** `skills/` 下的一级目录名（排序后）。 */
function skillDirectories(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** 读取并解析某个 Skill 的 SKILL.md。 */
function readSkillFrontmatter(name: string) {
  const file = path.join(SKILLS_ROOT, name, 'SKILL.md')
  return parseFirmwareSkillMarkdown(readFileSync(file, 'utf8'), file)
}

describe('DEV_DOMAIN 声明', () => {
  it('身份字段稳定，恰好 8 个 Skill 且名称唯一', () => {
    expect(DEV_DOMAIN.id).toBe('dev')
    expect(DEV_DOMAIN.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(DEV_DOMAIN.displayName.length).toBeGreaterThan(0)
    expect(DEV_DOMAIN.skills).toHaveLength(8)

    const names = DEV_DOMAIN.skills.map((skill) => skill.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(EXPECTED_SKILL_NAMES)
  })

  it('声明的 Skill 集合与 skills/ 目录精确相等（不多不少）', () => {
    const declared = DEV_DOMAIN.skills.map((skill) => skill.name).sort()
    expect(declared).toEqual(skillDirectories())
  })

  it('不占用 core 的保留 Skill 名', () => {
    for (const skill of DEV_DOMAIN.skills) {
      expect(CORE_RESERVED_SKILLS).not.toContain(skill.name)
    }
  })
})

describe.each(EXPECTED_SKILL_NAMES)('Skill %s', (name) => {
  const declared = DEV_DOMAIN.skills.find((skill) => skill.name === name)

  it('已声明且 dir 是存在的一级目录绝对路径', () => {
    expect(declared).toBeDefined()
    const dir = (declared as { dir: string }).dir
    expect(path.isAbsolute(dir)).toBe(true)
    expect(path.basename(dir)).toBe(name)
    expect(path.dirname(dir)).toBe(SKILLS_ROOT)
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true)
  })

  it('frontmatter.name 与目录名 / 声明名一致，description 与 whenToUse 非空', () => {
    const declaredSkill = declared as {
      name: string
      description: string
      dir: string
    }
    const parsed = readSkillFrontmatter(name)

    expect(parsed.name).toBe(declaredSkill.name)
    expect(parsed.name).toBe(path.basename(declaredSkill.dir))
    expect(parsed.description.trim()).not.toBe('')
    expect(parsed.whenToUse.trim()).not.toBe('')

    // 声明侧 description 是模型侧可见描述，不能为空（与 frontmatter 同源）。
    expect(declaredSkill.description.trim()).not.toBe('')

    // 正文已剥离 frontmatter，模型可见内容不含元数据围栏。
    expect(parsed.content.startsWith('---')).toBe(false)
    expect(parsed.content.trim().length).toBeGreaterThan(0)
  })
})

describe('dev-test-strategy references', () => {
  it('references/ 恰好 5 个 .md，且与声明清单精确相等', () => {
    const entries = readdirSync(REFERENCES_ROOT, { withFileTypes: true })
    expect(entries.every((entry) => entry.isFile())).toBe(true)

    const files = entries.map((entry) => entry.name).sort()
    expect(files).toHaveLength(5)
    expect(files.every((file) => file.endsWith('.md'))).toBe(true)
    expect(files).toEqual(EXPECTED_REFERENCE_STACKS.map((stack) => `${stack}.md`).sort())

    for (const file of files) {
      expect(statSync(path.join(REFERENCES_ROOT, file)).size).toBeGreaterThan(0)
    }
  })

  it('SKILL.md 为全部 5 个栈声明了 references/<stack>.md 路由', () => {
    const content = readSkillFrontmatter('dev-test-strategy').content
    for (const stack of EXPECTED_REFERENCE_STACKS) {
      expect(content).toContain(`references/${stack}.md`)
    }
  })
})

describe('Leader 人设', () => {
  it('personaMarkdown 非空、以 "# Dev Leader" 开头且在 64 KB 以内', () => {
    const markdown = DEV_DOMAIN.personaMarkdown
    expect(markdown.trim().length).toBeGreaterThan(0)
    expect(markdown.startsWith('# Dev Leader')).toBe(true)
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThan(64 * 1024)
  })

  it('LEADER_PERSONA 与 DEV_DOMAIN.personaMarkdown 同源（同一字符串）', () => {
    expect(LEADER_PERSONA).toBe(DEV_DOMAIN.personaMarkdown)
  })

  it('人设承载 Leader 的关键规则段落（阶段 / Red Lines / 检查清单）', () => {
    const markdown = DEV_DOMAIN.personaMarkdown
    expect(markdown).toContain('## 阶段 1 · 对齐')
    expect(markdown).toMatch(/Red Lines/)
    expect(markdown).toContain('- [ ]')
  })
})
