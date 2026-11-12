import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 *
 * `passWithNoTests: false`：用例集为空必须失败。否则 include 写错、测试文件被
 * 误删都会静默变绿，CI 失去意义。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
  },
})
