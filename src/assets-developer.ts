/**
 * `dev-assets-developer`：Developer preset 的角色资产（7 个领域 Skill）。
 *
 * 编码类技能面：实现计划、自审、调试、可观测性、测试策略、角色细则、环境。
 * 由 `preset-dev-developer.plugins` 首项挂载，注册进该 preset 的 scope 层。
 */
import { createAssetsPlugin, DEVELOPER_SKILLS, pickSkills } from './assets.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-assets-developer` 一致）。 */
export const name = 'dev-assets-developer'

/** 不声明注入：Skill 注册走非严格探测，服务缺失时降级为 warn。 */
export const inject: string[] = []

const plugin = createAssetsPlugin(name, pickSkills(DEVELOPER_SKILLS))

/** 插件装配入口。 */
export const apply = plugin.apply
