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

  it('breaks on a score below the threshold set after the first measurement (ADR-0110 item 9)', () => {
    const threshold = config.default.thresholds.break;
    expect(threshold).not.toBeNull();
    expect((threshold ?? -1) % 5).toBe(0);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThanOrEqual(100);
  });
});

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly 'timeout-minutes': number;
  readonly steps: readonly Step[];
}

const full = parse(readFileSync('.github/workflows/mutation.yml', 'utf8')) as { jobs: { mutation: Job } };
const lines = parse(readFileSync('.github/workflows/mutation-lines.yml', 'utf8')) as {
  on: Readonly<Record<string, { inputs?: Readonly<Record<string, { required?: boolean; type?: string }>> }>>;
  jobs: { mutation: Job };
};
const lineSteps = lines.jobs.mutation.steps;

describe('the mutation testing of given lines (ADR-0132)', () => {
  it('runs only by hand, and asks for the range', () => {
    expect(Object.keys(lines.on)).toEqual(['workflow_dispatch']);
    expect(lines.on['workflow_dispatch']?.inputs?.['mutate']).toMatchObject({ required: true, type: 'string' });
  });

  it('gets as long as mutation.yml, and the same pinned actions', () => {
    expect(lines.jobs.mutation['timeout-minutes']).toBe(full.jobs.mutation['timeout-minutes']);
    const actions = (steps: readonly Step[]): string[] => steps.flatMap(({ uses }) => (uses === undefined ? [] : [uses]));
    expect(actions(lineSteps)).toEqual(actions(full.jobs.mutation.steps));
  });

  it('takes the settings of stryker.config.mjs and drops only the break threshold', () => {
    const run = lineSteps.find(({ name }) => name === 'Mutation testing')?.run ?? '';
    expect(run).toContain("import base from './stryker.config.mjs';");
    expect(run).toContain('thresholds: { ...base.thresholds, break: null }');
    expect(run).toContain('--mutate "$MUTATE"');
  });

  // 輸入放進環境變數再用，不直接嵌進指令，免得被拿來注入指令。
  it('reads the range from the environment, never from the script itself', () => {
    for (const { run, env } of lineSteps) {
      expect(run ?? '').not.toContain('${{');
      if (run?.includes('$MUTATE') === true) expect(env?.['MUTATE']).toBe('${{ inputs.mutate }}');
    }
  });

  it('takes TypeScript files under src/ with line ranges, and nothing else', () => {
    const check = lineSteps.find(({ name }) => name === 'Check the range')?.run ?? '';
    const pattern = new RegExp(/pattern='([^']+)'/u.exec(check)?.[1] ?? '$^', 'u');
    const accepted = (range: string): boolean => pattern.test(range) && !range.includes('..');
    expect(check).toContain('== *..*');
    expect(accepted('src/core/report.ts:84-96,src/core/pipeline.ts:49-54')).toBe(true);
    expect(accepted('src/cli/run.ts')).toBe(true);
    for (const range of ['tests/core/report.test.ts', 'src/../x.ts', 'src/a.ts; echo', 'src/a.ts:1-2,', 'src/a.js', 'src/a.ts:1']) {
      expect(accepted(range)).toBe(false);
    }
  });
});
