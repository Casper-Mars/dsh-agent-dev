/**
 * Dev Leader 人设（主会话注入，常驻 system prompt）。
 *
 * 正文在 `src/persona/LEADER.md`，构建时由 `scripts/copy-assets.mjs` 按原相对路径
 * 复制到 `dist-server/persona/LEADER.md`，源码态与编译态共用一条路径语义。
 * 导出名与类型（`string`）保持不变，`src/domain.ts` / `src/plugin.ts` / `src/index.ts`
 * 无需感知这次拆分；子 agent 使用各自 preset 的 persona，不继承这里。
 */
import { readFileSync } from 'node:fs'

/** Leader 人设正文；行尾统一 LF，去掉文件尾部的空行，保持与旧数组 `join('\n')` 完全一致。 */
export const LEADER_PERSONA = readFileSync(new URL('./persona/LEADER.md', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\n+$/, '')
