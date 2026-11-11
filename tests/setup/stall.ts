import { cpus, freemem, totalmem } from 'node:os';

// 測試逾時時的診斷（ADR-0131）。Windows 的 CI 曾經三個 worker 同時停住約 4 分半，日誌只有每個測試的時間，
// 分不出是測試自己在忙、別的行程占著 CPU，還是整台 runner 停了。這裡只放讀數與格式，掛勾在 `timeouts.ts`。

/** 所有 CPU 加總的時間，毫秒。 */
export interface MachineTimes {
  readonly busy: number;
  readonly total: number;
  readonly count: number;
}

/** 一個測試開始或結束時的讀數。 */
export interface Reading {
  /** `performance.now()`，毫秒。 */
  readonly at: number;
  /** 這個 worker 行程累計的 CPU 時間，微秒。 */
  readonly cpu: NodeJS.CpuUsage;
  readonly machine: MachineTimes;
}

export interface Memory {
  readonly freeBytes: number;
  readonly totalBytes: number;
  /** 這個 worker 行程的常駐記憶體。 */
  readonly rssBytes: number;
}

export interface Stall extends Memory {
  readonly wallMs: number;
  /** 這個 worker 在這段時間用掉的 CPU 時間（user 加 system）。 */
  readonly workerCpuMs: number;
  /** 整台機器在這段時間的 CPU 忙碌比例，0 到 1。 */
  readonly machineBusy: number;
  readonly cpuCount: number;
  /** 事件迴圈在這段時間最長的延遲。 */
  readonly loopDelayMs: number;
}

export function machineTimes(): MachineTimes {
  let busy = 0;
  let total = 0;
  const all = cpus();
  for (const { times } of all) {
    const sum = times.user + times.nice + times.sys + times.idle + times.irq;
    total += sum;
    busy += sum - times.idle;
  }
  return { busy, total, count: all.length };
}

export function reading(): Reading {
  return { at: performance.now(), cpu: process.cpuUsage(), machine: machineTimes() };
}

export function memory(): Memory {
  return { freeBytes: freemem(), totalBytes: totalmem(), rssBytes: process.memoryUsage.rss() };
}

/** `loopDelayNs` 是 `monitorEventLoopDelay` 的最大值，奈秒；沒有取樣時是 0。 */
export function measure(start: Reading, end: Reading, loopDelayNs: number, used: Memory): Stall {
  const total = end.machine.total - start.machine.total;
  return {
    wallMs: end.at - start.at,
    workerCpuMs: (end.cpu.user - start.cpu.user + end.cpu.system - start.cpu.system) / 1000,
    machineBusy: total > 0 ? (end.machine.busy - start.machine.busy) / total : 0,
    cpuCount: end.machine.count,
    loopDelayMs: loopDelayNs / 1e6,
    ...used,
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const gib = (bytes: number): string => (bytes / 2 ** 30).toFixed(1);

/**
 * 一行，給人讀 CI 的日誌。worker 的 CPU 接近牆鐘時間是測試自己在忙；遠小於牆鐘、整台機器又很忙，是別的行程占著；
 * 兩者都低、事件迴圈的延遲卻很長，是 worker 沒被排到，像整台 runner 停住。
 */
export function describeStall(name: string, stall: Stall): string {
  return [
    `[timeout diagnostics] ${name}:`,
    `wall ${seconds(stall.wallMs)},`,
    `this worker's CPU ${seconds(stall.workerCpuMs)},`,
    `machine CPU ${Math.round(stall.machineBusy * 100)}% busy across ${stall.cpuCount} CPUs,`,
    `event loop delay up to ${seconds(stall.loopDelayMs)},`,
    `free memory ${gib(stall.freeBytes)} of ${gib(stall.totalBytes)} GiB,`,
    `worker RSS ${Math.round(stall.rssBytes / 2 ** 20)} MiB`,
  ].join(' ');
}

/** vitest 的逾時訊息是 `Test timed out in 30000ms.`。 */
export function timedOut(errors: readonly { readonly message?: string }[] | undefined): boolean {
  return (errors ?? []).some(({ message }) => message?.startsWith('Test timed out in ') === true);
}
