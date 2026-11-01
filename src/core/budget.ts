// 預算是硬上限，以書為單位累計（ADR-0035、ADR-0081）。估價都取區間上限。
// 這是送出前的上限，花費要到回應才知道，實際可能略超過，所以供應商後台的上限是第二道保險。

export interface BudgetCheck {
  readonly budget_usd: number;
  /** 帳本裡已經花掉的。 */
  readonly spent_usd: number;
  /** 已送出、還沒收回的估價。 */
  readonly in_flight_usd: number;
  /** 這次要送的估價。 */
  readonly next_usd: number;
}

export interface BudgetResult {
  readonly ok: boolean;
  readonly remaining_usd: number;
}

export function checkBudget({ budget_usd, spent_usd, in_flight_usd, next_usd }: BudgetCheck): BudgetResult {
  const remaining_usd = budget_usd - spent_usd - in_flight_usd - next_usd;
  return { ok: remaining_usd >= 0, remaining_usd };
}
