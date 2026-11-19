/**
 * 角色资产的共享实现：把一组领域 Skill 注册进调用它的 agent scope。
 *
 * 为什么按 preset 拆：dsh 的 Skill 注册表是 host + per-scope 分层，「由某个
 * preset 的常驻组合挂载的插件」注册进该 preset 的层。三个 preset 的技能面
 * 本来就不同（Leader 编排、Developer 编码、Tester 验收），留在宿主层会并成
 * 一份，合并到单 host 时尤其明显。
 *
 * 每个 preset 一个模块（`assets-leader.ts` / `assets-developer.ts` /
 * `assets-tester.ts`），本文件只提供工厂与清单，不导出插件本身。
 */
import type { Context } from '@deepseek-ai/cordis'
import { DEV_DOMAIN } from './domain.js'
import type { FirmwareSkill } from './firmware.js'
import { createDomainLogger, readService, registerDomainFirmwareSkills } from './plugin.js'

/**
 * 各 preset 的技能面（按角色职责划分，允许跨角色复用）。
 *
 * 归属依据是「该角色会不会真的用这条技能」：
 * - Leader：派单契约、分支纪律、质量门、发布、复盘、环境
 * - Developer：实现计划、自审、调试、可观测性、测试策略、角色细则、环境
 * - Tester：验收细则、测试策略、质量门、环境
 */
export const LEADER_SKILLS = [
  'dev-dispatch-contract',
  'dev-environment',
  'dev-quality-gate',
  'dev-release',
  'dev-retro',
  'dev-worktree-git',
] as const

export const DEVELOPER_SKILLS = [
  'dev-code-review',
  'dev-environment',
  'dev-implementation-plan',
  'dev-observability',
  'dev-role-developer',
  'dev-systematic-debugging',
  'dev-test-strategy',
] as const

export const TESTER_SKILLS = [
  'dev-environment',
  'dev-quality-gate',
  'dev-role-tester',
  'dev-test-strategy',
  'dev-ui-review',
] as const

/** 按名字取领域 Skill；名字写错时直接抛错（构建期/测试期暴露，不静默丢技能）。 */
export function pickSkills(names: readonly string[]): readonly FirmwareSkill[] {
  const byName = new Map(DEV_DOMAIN.skills.map((skill) => [skill.name, skill]))
  return names.map((name) => {
    const skill = byName.get(name)
    if (skill === undefined) {
      throw new Error(`[dev] 未知的领域 Skill "${name}"：请检查 assets 清单与 DEV_DOMAIN.skills 是否一致`)
    }
    return skill
  })
}

/**
 * 构造一个 preset 层的资产插件。
 * @param id - 插件实例 id（与 `cordis.patch.yml` 逐字一致）。
 * @param skills - 该 preset 可见的领域 Skill。
 * @param persona - 该 preset 的根会话人设；给了就在 scope 里注册
 *   `deployment:persona-prefix`（人设必须随 preset 组合启停，见下）。
 */
export function createAssetsPlugin(
  id: string,
  skills: readonly FirmwareSkill[],
  persona?: string,
) {
  return {
    name: id,
    /** 不声明 `inject`：Skill / persona 注册走非严格探测，服务缺失时降级为 warn。 */
    inject: [] as string[],
    apply(ctx: Context): void {
      const logger = createDomainLogger(readService(ctx, 'logger'), id)

      if (persona !== undefined) {
        ctx.effect(() => {
          const prompt = readSystemPrompt(ctx)
          if (prompt === undefined) {
            logger.warn('preset scope 缺少 systemPrompt 服务，persona 降级为不注入（Skill 注册不受影响）')
            return () => {}
          }
          return prompt.section({
            name: 'deployment:persona-prefix',
            order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: persona,
          })
        }, `${id}:persona`)
      }

      ctx.effect(() => {
        const unregisters = registerDomainFirmwareSkills(ctx, skills, logger, {
          // 这里的 ctx 是 agent 的 preset scope：宿主层读不到这些 Skill，
          // 「注册后是否可见」的核验只会产生假告警，关掉。
          verifyWinner: false,
        })

        return () => {
          for (let index = unregisters.length - 1; index >= 0; index -= 1) {
            try {
              unregisters[index]?.()
            } catch (error) {
              logger.warn('领域 Skill 反注册失败', error)
            }
          }
        }
      }, `${id}:register-skills`)
    },
  }
}

/** `ctx.systemPrompt` 的最小结构（非严格读取，缺失时降级）。 */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
  getSectionOrder(name: string): number
}

function readSystemPrompt(ctx: Context): SystemPromptLike | undefined {
  const value = readService(ctx, 'systemPrompt')
  if (
    value !== null
    && typeof value === 'object'
    && typeof (value as SystemPromptLike).section === 'function'
    && typeof (value as SystemPromptLike).getSectionOrder === 'function'
  ) {
    return value as SystemPromptLike
  }
  return undefined
}
