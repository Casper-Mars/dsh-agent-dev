/**
 * `dev-assets-tester`：Tester preset 的角色资产（4 个领域 Skill）。
 *
 * 验收类技能面：验收细则、测试策略、质量门、环境。
 * 由 `preset-dev-tester.plugins` 首项挂载，注册进该 preset 的 scope 层。
 */
import { createAssetsPlugin, pickSkills, TESTER_SKILLS } from './assets.js'

/** 插件唯一标识（必须与 `cordis.patch.yml` 中的 `dev-assets-tester` 一致）。 */
export const name = 'dev-assets-tester'

/** 不声明注入：Skill 注册走非严格探测，服务缺失时降级为 warn。 */
export const inject: string[] = []

const plugin = createAssetsPlugin(name, pickSkills(TESTER_SKILLS))

/** 插件装配入口。 */
export const apply = plugin.apply
