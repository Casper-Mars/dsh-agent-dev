import { describe, expect, it } from 'vitest'
import { checkDeliveryGate } from '../src/asset'

describe('delivery gate', () => {
  it('rejects a synthetic report without ## 资产', () => {
    const result = checkDeliveryGate('## 改了什么\n- 只改了一个文件\n', true)
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('报告缺少 `## 资产` 段')
  })

  it('rejects unsettled staging even with the section', () => {
    const result = checkDeliveryGate('## 资产\n- used: none\n', false)
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('staging 有未结算条目')
  })

  it('accepts a complete report with settled staging', () => {
    const result = checkDeliveryGate('## 资产\n- used: web-ui/runner\n', true)
    expect(result).toEqual({ ok: true, reasons: [] })
  })
})
