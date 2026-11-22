/** 交付门禁：Leader 在 triage 时用同一套规则判断报告能不能进下一步。 */
export interface DeliveryGateResult {
  ok: boolean
  reasons: string[]
}

/** 纯函数，便于单测与二次封装；不读文件、不依赖 dsh。 */
export function checkDeliveryGate(report: string, stagingSettled: boolean): DeliveryGateResult {
  const reasons: string[] = []
  if (!/^##\s*资产\s*$/m.test(report)) reasons.push('报告缺少 `## 资产` 段')
  if (!stagingSettled) reasons.push('staging 有未结算条目')
  return { ok: reasons.length === 0, reasons }
}
