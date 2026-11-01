// 翻譯單位的狀態機（白皮書 §6.2、ADR-0102）。階段狀態由單位推導，不另外存一份（ADR-0081）。

export const UNIT_STATES = [
  'PENDING',
  'QUEUED',
  'BLOCKED',
  'IN_FLIGHT',
  'RECEIVED',
  'DONE',
  'REFUSED',
  'FAILED_QA',
  'STALE',
] as const;

export type UnitState = (typeof UNIT_STATES)[number];

export const UNIT_EVENTS = [
  'hit',
  'queue',
  'block',
  'release',
  'send',
  'requeue',
  'receive',
  'pass',
  'fail',
  'give_up',
  'refuse',
  'retry',
  'stale',
] as const;

export type UnitEvent = (typeof UNIT_EVENTS)[number];

/** 預設最多重送到這個次數，到了就標成 `FAILED_QA`（白皮書 §5.6）。 */
export const MAX_ATTEMPTS = 3;

const TRANSITIONS: Readonly<Record<UnitState, Partial<Record<UnitEvent, UnitState>>>> = {
  PENDING: { hit: 'DONE', queue: 'QUEUED' },
  QUEUED: { block: 'BLOCKED', send: 'IN_FLIGHT' },
  BLOCKED: { release: 'QUEUED' },
  IN_FLIGHT: { requeue: 'QUEUED', receive: 'RECEIVED' },
  RECEIVED: { pass: 'DONE', fail: 'QUEUED', give_up: 'FAILED_QA', refuse: 'REFUSED' },
  DONE: { stale: 'STALE' },
  REFUSED: { retry: 'QUEUED' },
  FAILED_QA: { retry: 'QUEUED', stale: 'STALE' },
  STALE: { pass: 'DONE', fail: 'QUEUED', give_up: 'FAILED_QA' },
};

/** 非法的轉換是程式錯誤，不是使用者能處理的狀況。 */
export function nextState(state: UnitState, event: UnitEvent): UnitState {
  const next = TRANSITIONS[state][event];
  if (next === undefined) throw new RangeError(`no transition from ${state} on ${event}`);
  return next;
}

/** 驗證失敗之後該走哪條路。`attempts` 是已經送過的次數。 */
export function failureEvent(attempts: number): 'fail' | 'give_up' {
  return attempts >= MAX_ATTEMPTS ? 'give_up' : 'fail';
}
