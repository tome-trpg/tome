import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// 變異測試的設定與 workflow 要一致（ADR-0063、ADR-0110）。這裡只讀檔案，不跑 Stryker：
// Stryker 只在 CI 跑。

interface StrykerConfig {
  readonly MUTATED: readonly string[];
  readonly default: {
    readonly mutate: readonly string[];
    readonly thresholds: { readonly break: number | null };
  };
}

interface Workflow {
  readonly on: {
    readonly schedule?: readonly { readonly cron: string }[];
    readonly workflow_dispatch?: unknown;
    readonly pull_request?: { readonly paths?: readonly string[] };
  };
  readonly jobs: {
    readonly mutation: {
      readonly strategy: { readonly matrix: { readonly include: readonly { readonly module: string; readonly files: string }[] } };
    };
  };
}

const config = (await import(pathToFileURL(resolve('stryker.config.mjs')).href)) as StrykerConfig;
const workflow = parse(readFileSync('.github/workflows/mutation.yml', 'utf8')) as Workflow;
const jobs = workflow.jobs.mutation.strategy.matrix.include;

describe('the mutation testing setup (ADR-0063, ADR-0110)', () => {
  it('mutates the six key modules, in files that exist', () => {
    expect(config.default.mutate).toEqual(config.MUTATED);
    expect(config.MUTATED).toHaveLength(8);
    for (const file of config.MUTATED) expect(existsSync(file)).toBe(true);
  });

  it('gives every file to exactly one job, one job a module', () => {
    expect(jobs.map(({ module }) => module).sort()).toEqual(['budget', 'egress', 'mask', 'memory', 'state', 'verify']);
    const files = jobs.flatMap(({ files: list }) => list.split(','));
    expect([...files].sort()).toEqual([...config.MUTATED].sort());
  });

  it('runs on a schedule, by hand, and on a pull request that changes the setup', () => {
    expect(workflow.on.schedule).toHaveLength(1);
    expect('workflow_dispatch' in workflow.on).toBe(true);
    expect(workflow.on.pull_request?.paths).toEqual(['stryker.config.mjs', '.github/workflows/mutation.yml']);
  });

  it('breaks on a score below the threshold only once one is set', () => {
    const threshold = config.default.thresholds.break;
    expect(threshold === null || (threshold >= 0 && threshold <= 100)).toBe(true);
  });
});
