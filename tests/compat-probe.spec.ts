/**
 * 兼容探针与包内自检的静态一致性（防止 `scripts/compat-probe.mjs` 悄悄漂移）。
 *
 * 探针在 CI 里是**独立进程**跑的（复制进临时 dsh 安装目录），拿不到本仓库的
 * 常量；一旦有人加了 Skill 却忘了同步探针，CI 仍会「通过」，因为探针只断言
 * 它自己那份列表。这里把三处清单钉在一起：domain 数据、verify-install、探针。
 */
import { describe, expect, it } from 'vitest'
import { DEV_DOMAIN } from '../src/domain.js'
import { EXPECTED_DEFAULT_PRESET, EXPECTED_PRESETS, EXPECTED_SKILLS } from '../scripts/compat-probe.mjs'
import { EXPECTED_REFERENCE_STACKS, EXPECTED_SKILLS as VERIFY_SKILLS } from '../scripts/verify-install.mjs'

describe('兼容探针清单', () => {
  it('探针的 Skill 清单与 verify-install 完全一致', () => {
    expect([...EXPECTED_SKILLS]).toEqual([...VERIFY_SKILLS])
  })

  it('探针的 Skill 清单与领域数据完全一致', () => {
    expect([...EXPECTED_SKILLS].sort()).toEqual(DEV_DOMAIN.skills.map((skill) => skill.name).sort())
  })

  it('探针声明的 preset 覆盖 leader / developer / tester', () => {
    expect([...EXPECTED_PRESETS].sort()).toEqual(['dev-developer', 'dev-leader', 'dev-tester'])
    expect(EXPECTED_DEFAULT_PRESET).toBe('dev-leader')
  })

  it('references 栈清单非空（dev-test-strategy 路由依赖）', () => {
    expect(EXPECTED_REFERENCE_STACKS.length).toBeGreaterThan(0)
  })
})
