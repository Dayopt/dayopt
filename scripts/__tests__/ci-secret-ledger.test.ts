import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ciSecretSchema } from '../tasks/env/schema';

// GitHub Actions Secrets は 1Password `ci` vault の replica（docs/operations/secrets.md
// §Replica 台帳）。基本方針 7「値がどこにあっても 1Password にもある」を、名前の対応で
// 機械検査する。GitHub の Secret 一覧 API は admin 権限が要り CI からも agent からも
// 読めないため、workflow が参照する名前を「実在する replica」の代理として使う。
//
// 2026-09-14 から CI の Secret は repo 単位ではなく、main からだけ使える environment に置く。
// 他 branch に workflow を足しても secrets を読めないようにするため、secrets を参照する job は
// 必ず台帳に載った environment を宣言する。
//
// 保証境界: workflow が参照する名前・job の environment 宣言と台帳の対応だけを見る。値の一致、
// どの workflow にも参照されない GitHub Secret（orphan）、environment の branch policy の実設定は
// 見ない（policy は GitHub の設定で、repo からは読めない）。YAML は行単位で読む簡易解析で、
// jobs 直下 2 space の job key と、その job 内 4 space の `environment:` だけを解釈する。
const rootDir = resolve(import.meta.dirname, '../..');
const workflowDir = join(rootDir, '.github/workflows');
// GitHub が run ごとに自動発行する token。replica ではない
const PLATFORM_SECRETS = new Set(['GITHUB_TOKEN']);
// 式 `${{ ... secrets.NAME ... }}` の中だけを見る（コメント中の docs/operations/secrets.md 等を拾わない）
const SECRET_EXPRESSION = /\$\{\{[^}]*?\bsecrets\.([A-Z0-9_]+)/g;

type SecretUse = { file: string; job: string; environment: string | null; secret: string };

function parseSecretUses(file: string, text: string): SecretUse[] {
  const uses: SecretUse[] = [];
  const lines = text.split('\n');
  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) return uses;

  const jobs: { name: string; lines: string[] }[] = [];
  for (const line of lines.slice(jobsStart + 1)) {
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) jobs.push({ name: key[1], lines: [] });
    else if (/^\S/.test(line)) break;
    else jobs.at(-1)?.lines.push(line);
  }

  for (const job of jobs) {
    let environment: string | null = null;
    job.lines.forEach((line, index) => {
      const scalar = line.match(/^ {4}environment:\s*([A-Za-z0-9_.-]+)\s*$/);
      if (scalar) environment = scalar[1];
      if (/^ {4}environment:\s*$/.test(line)) {
        for (const child of job.lines.slice(index + 1)) {
          if (!/^ {6}/.test(child)) break;
          const name = child.match(/^ {6}name:\s*([A-Za-z0-9_.-]+)\s*$/);
          if (name) environment = name[1];
        }
      }
    });
    const body = job.lines.join('\n');
    for (const match of body.matchAll(SECRET_EXPRESSION)) {
      if (PLATFORM_SECRETS.has(match[1])) continue;
      uses.push({ file, job: job.name, environment, secret: match[1] });
    }
  }
  return uses;
}

function allSecretUses(): SecretUse[] {
  return readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((file) => parseSecretUses(file, readFileSync(join(workflowDir, file), 'utf8')));
}

const ledgerByName = new Map(
  ciSecretSchema.map((entry) => [entry.githubSecret ?? entry.envName, entry]),
);

describe('CI secret ledger（workflow の secrets.* ⇔ 1Password ci vault）', () => {
  it('workflow が参照する GitHub Secret はすべて ci 台帳に master を持つ', () => {
    const missing = allSecretUses()
      .filter((use) => !ledgerByName.has(use.secret))
      .map((use) => `${use.secret}（${use.file} / ${use.job}）`);
    expect([...new Set(missing)], '台帳に無い Secret を足すか、workflow から参照を外す').toEqual(
      [],
    );
  });

  it('secrets を参照する job はすべて、台帳に載った environment を宣言する', () => {
    const violations = allSecretUses()
      .filter((use) => ledgerByName.has(use.secret))
      .filter((use) => {
        const environments = ledgerByName.get(use.secret)?.githubEnvironments ?? [];
        return use.environment === null || !environments.includes(use.environment);
      })
      .map(
        (use) => `${use.file} / ${use.job}: ${use.secret} in ${use.environment ?? '(repo 単位)'}`,
      );
    expect([...new Set(violations)]).toEqual([]);
  });

  it('台帳の (Secret, environment) の組はすべてどこかの job が使っている', () => {
    const used = new Set(allSecretUses().map((use) => `${use.secret}@${use.environment}`));
    const unused = ciSecretSchema.flatMap((entry) =>
      (entry.githubEnvironments ?? ['(none)'])
        .map((environment) => `${entry.githubSecret ?? entry.envName}@${environment}`)
        .filter((pair) => !used.has(pair)),
    );
    expect(unused).toEqual([]);
  });

  it('environment 同期 script の一覧は台帳と 1:1（Secret 名・environment・1Password 参照）', () => {
    const script = readFileSync(
      join(rootDir, 'scripts/runbook/sync-ci-environment-secrets.sh'),
      'utf8',
    );
    const scripted = [...script.matchAll(/^secret (\S+) (\S+) "(op:\/\/[^"]+)"$/gm)]
      .map(([, environment, name, ref]) => `${environment} ${name} ${ref}`)
      .sort();
    const ledger = ciSecretSchema
      .flatMap((entry) =>
        (entry.githubEnvironments ?? []).map(
          (environment) =>
            `${environment} ${entry.githubSecret ?? entry.envName} op://${entry.vault}/${entry.item}/${entry.field}`,
        ),
      )
      .sort();
    expect(scripted.length).toBeGreaterThan(0);
    expect(scripted).toEqual(ledger);
  });

  it('ci 台帳は ci vault だけを指し、Secret 名は重複しない', () => {
    expect(ciSecretSchema.every((entry) => entry.vault === 'ci')).toBe(true);
    expect(ledgerByName.size).toBe(ciSecretSchema.length);
  });

  it('parser は environment 無しの job と、別 environment の job を見分ける（検査が空振りしない）', () => {
    const workflow = [
      'on: push',
      'jobs:',
      '  leaky:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo',
      '        env:',
      '          T: ${{ secrets.VERCEL_TOKEN }}',
      '  scoped:',
      '    runs-on: ubuntu-latest',
      '    environment:',
      '      name: production-ops',
      '      deployment: false',
      '    steps:',
      '      - run: echo ${{ secrets.GITHUB_TOKEN }}',
      '        env:',
      '          T: ${{ secrets.SUPABASE_AUTH_AUDIT_TOKEN }}',
      '  scalar:',
      '    environment: production-release',
      '    steps:',
      '      - env:',
      '          T: ${{ secrets.VERCEL_AUTOMATION_BYPASS_WEB }}',
      '# docs/operations/secrets.md の言及は拾わない',
    ].join('\n');
    expect(parseSecretUses('fixture.yml', workflow)).toEqual([
      { file: 'fixture.yml', job: 'leaky', environment: null, secret: 'VERCEL_TOKEN' },
      {
        file: 'fixture.yml',
        job: 'scoped',
        environment: 'production-ops',
        secret: 'SUPABASE_AUTH_AUDIT_TOKEN',
      },
      {
        file: 'fixture.yml',
        job: 'scalar',
        environment: 'production-release',
        secret: 'VERCEL_AUTOMATION_BYPASS_WEB',
      },
    ]);
  });
});
