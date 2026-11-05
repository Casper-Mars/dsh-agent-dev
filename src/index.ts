/**
 * `dsh-dev-domain` 包入口：导出 Cordis 插件三要素与 `dev` 领域数据。
 *
 * `package.json` 的 `exports["."]` 指向本文件的编译产物
 * （`dist-server/index.js`）。领域数据只暴露 {@link DEV_DOMAIN}：
 * 旧的 pack / seeds 导出已在任务-02 删除。
 */
export { name, apply, inject } from './plugin.js'
export { DEV_DOMAIN, type DevDomain, type DevSkill } from './domain.js'
export { LEADER_PERSONA } from './persona.js'
