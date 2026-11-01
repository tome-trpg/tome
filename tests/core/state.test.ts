import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  failureEvent,
  MAX_ATTEMPTS,
  nextState,
  UNIT_EVENTS,
  UNIT_STATES,
  type UnitEvent,
  type UnitState,
} from '../../src/core/state.ts';

// 白皮書 §6.2 的圖，獨立寫一份，當成狀態機的模型。

const EDGES: readonly (readonly [UnitState, UnitEvent, UnitState])[] = [
  ['PENDING', 'hit', 'DONE'],
  ['PENDING', 'queue', 'QUEUED'],
  ['QUEUED', 'block', 'BLOCKED'],
  ['BLOCKED', 'release', 'QUEUED'],
  ['QUEUED', 'send', 'IN_FLIGHT'],
  ['IN_FLIGHT', 'requeue', 'QUEUED'],
  ['IN_FLIGHT', 'receive', 'RECEIVED'],
  ['RECEIVED', 'pass', 'DONE'],
  ['RECEIVED', 'fail', 'QUEUED'],
  ['RECEIVED', 'give_up', 'FAILED_QA'],
  ['RECEIVED', 'refuse', 'REFUSED'],
  ['REFUSED', 'retry', 'QUEUED'],
  ['FAILED_QA', 'retry', 'QUEUED'],
  ['DONE', 'stale', 'STALE'],
  ['STALE', 'pass', 'DONE'],
  ['STALE', 'fail', 'QUEUED'],
  ['FAILED_QA', 'stale', 'STALE'],
  ['STALE', 'give_up', 'FAILED_QA'],
];

const START: UnitState = 'PENDING';

function expected(state: UnitState, event: UnitEvent): UnitState | undefined {
  return EDGES.find(([from, on]) => from === state && on === event)?.[2];
}

interface Model {
  state: UnitState;
}

interface Real {
  state: UnitState;
}

class Fire implements fc.Command<Model, Real> {
  readonly event: UnitEvent;

  constructor(event: UnitEvent) {
    this.event = event;
  }

  /** 隨機事件大多不合法，只走合法的路才到得了深處的狀態。非法的轉換由另一個測試逐一檢查。 */
  check(model: Readonly<Model>): boolean {
    return expected(model.state, this.event) !== undefined;
  }

  run(model: Model, real: Real): void {
    real.state = nextState(real.state, this.event);
    model.state = expected(model.state, this.event) ?? model.state;
    expect(real.state).toBe(model.state);
  }

  toString(): string {
    return this.event;
  }
}

describe('the unit state machine', () => {
  it.each(EDGES)('%s on %s goes to %s', (from, on, to) => {
    expect(nextState(from, on)).toBe(to);
  });

  it('refuses everything the diagram does not draw', () => {
    for (const state of UNIT_STATES) {
      for (const event of UNIT_EVENTS) {
        if (expected(state, event) === undefined) {
          expect(() => nextState(state, event)).toThrow(RangeError);
        }
      }
    }
  });

  it('matches the model over any sequence of events', () => {
    const commands = fc.commands(
      UNIT_EVENTS.map((event) => fc.constant(new Fire(event))),
      // 序列太短走不到 STALE 之後的路。
      { maxCommands: 200, size: 'max' },
    );
    fc.assert(
      fc.property(commands, (sequence) => {
        fc.modelRun(() => ({ model: { state: START }, real: { state: START } }), sequence);
      }),
    );
  });

  it('can reach every state from the start', () => {
    const reached = new Set<UnitState>(['PENDING']);
    for (let round = 0; round < UNIT_STATES.length; round += 1) {
      for (const [from, , to] of EDGES) if (reached.has(from)) reached.add(to);
    }
    expect([...reached].sort()).toEqual([...UNIT_STATES].sort());
  });

  it('lets a unit leave every state', () => {
    for (const state of UNIT_STATES) {
      expect(EDGES.some(([from]) => from === state)).toBe(true);
    }
  });
});

describe('failureEvent', () => {
  it('sends a failed unit again until the limit of 3', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(failureEvent(1)).toBe('fail');
    expect(failureEvent(2)).toBe('fail');
    expect(failureEvent(3)).toBe('give_up');
    expect(failureEvent(4)).toBe('give_up');
  });
});
