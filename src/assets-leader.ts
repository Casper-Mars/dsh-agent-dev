/**
 * `dev-assets-leader`：Leader preset 的角色资产（6 个领域 Skill）。
 *
 * 编排类技能的入口：派单契约、分支纪律、质量门、发布、复盘、环境。
 * 由 `preset-dev-leader.plugins` 首项挂载，注册进该 preset 的 scope 层。
 */
import { createAssetsPlugin, LEADER_SKILLS, pickSkills } from './assets.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-assets-leader` 一致）。 */
export const name = 'dev-assets-leader'

/** 不声明注入：Skill 注册走非严格探测，服务缺失时降级为 warn。 */
export const inject: string[] = []

const plugin = createAssetsPlugin(name, pickSkills(LEADER_SKILLS))

/** 插件装配入口。 */
export const apply = plugin.apply
