import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * ci.yml の token 分離原則（2026-09-14、credential audit P2-6）:
 * **PR head のコードや依存を実行する job に write 権限の token を持たせない。**
 *
 * `pull_request` の ci.yml は PR branch の checkout・`pnpm install`（postinstall）・
 * vitest transform・eslint plugin・`node scripts/...` を実行する。そこに
 * `pull-requests: write` / `issues: write` の GITHUB_TOKEN があると、PR 側のコードや
 * 依存がその token で repo の issue / PR を書き換えられる。以前の unit job は
 * migration safety の通知のために write 権限を持ち、check.mjs 内で GH_TOKEN を env から
 * 押収するだけが防御だった（同じ step で動く PR head の check.mjs 自身は token を読める）。
 * 通知は checkout も install もしない `migration-notice` job へ移した。
 *
 * ── この guard の保証境界 ─────────────────────────────────────────
 * 走査は YAML パーサを使わず、**2 スペース indent の block style** を前提に行単位で読む
 * （ci-job-name-contract.test.ts の checkout 検査と同じ方針。repo root に YAML パーサの
 * 依存が無く、この検査のためだけに足さない）。
 *
 * 保証すること:
 * - ci.yml の各 job について、checkout / local action（`uses: ./`）/ pnpm・npm・npx・yarn・
 *   node の実行を含むなら、実効 permissions（job 単位の宣言、無ければ workflow 単位）に
 *   `write` / `write-all` が無い。permissions 宣言がどこにも無い job は repo 既定が write
 *   でありうるため write 扱い（fail closed）
 * - write 権限を持つ job は `uses:` を 1 つも持たない（第三者 action・composite action を
 *   write token の下で動かさない）
 * - migration-notice job の run script を偽 gh で実際に実行し、入力 allowlist と通知の
 *   順序・fail open を固定する
 *
 * 保証しないこと:
 * - flow style（`{ contents: read }`）の permissions、anchor / alias、reusable workflow
 * - ci.yml 以外の workflow（promote.yml / nightly.yml は push / schedule で main の
 *   信頼済みコードを実行する前提。`pull_request` で PR コードを動かす workflow を足したら
 *   ここへ加えること）
 * - run script が curl 等で外部コードを取得して実行するケース
 */

const CI_YML = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const FINISH_BRANCH = readFileSync(join(process.cwd(), 'scripts/tasks/finish-branch.sh'), 'utf8');

const withoutCommentLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const indentOf = (line: string) => line.length - line.trimStart().length;

interface Permissions {
  inline: string;
  scopes: Record<string, string>;
}

/** `<indent>permissions:` の宣言を読む。宣言が無ければ null。 */
function readPermissions(lines: string[], indent: number): Permissions | null {
  const pattern = new RegExp(`^ {${indent}}permissions:\\s*(.*)$`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return null;
  const inline = (lines[index].match(pattern)?.[1] ?? '').trim();
  const scopes: Record<string, string> = {};
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) <= indent) break;
    const match = line.match(/^\s*([\w-]+):\s*(\S+)/);
    if (match) scopes[match[1]] = match[2];
  }
  return { inline, scopes };
}

const hasWrite = (permissions: Permissions | null) =>
  permissions === null ||
  permissions.inline === 'write-all' ||
  Object.values(permissions.scopes).includes('write');

interface Job {
  id: string;
  text: string;
  lines: string[];
}

/** `jobs:` 直下（indent 2）の job ごとに、コメント行を除いた本文を切り出す。 */
function jobsOf(yamlText: string): Job[] {
  const lines = withoutCommentLines(yamlText).split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const jobs: Job[] = [];
  let current: { id: string; lines: string[] } | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // 次の top-level key
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      if (current) jobs.push({ ...current, text: current.lines.join('\n') });
      current = { id: header[1], lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) jobs.push({ ...current, text: current.lines.join('\n') });
  return jobs;
}

const REPOSITORY_CODE_MARKERS: [string, RegExp][] = [
  ['checkout', /^\s*(-\s+)?uses:\s*['"]?actions\/checkout@/m],
  ['local action', /^\s*(-\s+)?uses:\s*['"]?\.\//m],
  ['package manager', /(^|[\s;&|(])(pnpm|npm|npx|yarn|corepack)(\s|$)/m],
  ['node', /(^|[\s;&|(])node(\s|$)/m],
];

const repositoryCodeMarkers = (job: Job) =>
  REPOSITORY_CODE_MARKERS.filter(([, pattern]) => pattern.test(job.text)).map(([label]) => label);

/** 実効 permissions に write があり、かつ repo のコードを実行する job を列挙する。 */
function writeTokenOffenders(yamlText: string): string[] {
  const workflowPermissions = readPermissions(withoutCommentLines(yamlText).split('\n'), 0);
  return jobsOf(yamlText).flatMap((job) => {
    const effective = readPermissions(job.lines, 4) ?? workflowPermissions;
    const markers = repositoryCodeMarkers(job);
    if (!hasWrite(effective)) return [];
    const offenses: string[] = [];
    if (markers.length > 0) offenses.push(`${job.id}: write token + ${markers.join(', ')}`);
    if (/^\s*(-\s+)?uses:/m.test(job.text)) offenses.push(`${job.id}: write token + uses`);
    return offenses;
  });
}

const ciJobs = jobsOf(CI_YML);
const jobById = (id: string) => {
  const job = ciJobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`ci.yml に job ${id} が無い`);
  return job;
};

describe('ci.yml の token 分離（credential audit P2-6）', () => {
  it('repo のコードや依存を実行する job は write 権限の token を持たない', () => {
    expect(writeTokenOffenders(CI_YML)).toEqual([]);
  });

  it('GH_TOKEN を渡す job のうち repo のコードを実行するものは read-only に限る', () => {
    const workflowPermissions = readPermissions(withoutCommentLines(CI_YML).split('\n'), 0);
    const tokenJobs = ciJobs.filter((job) => /github\.token|secrets\.GITHUB_TOKEN/.test(job.text));

    // impact / unit（read-only で PR files を読む）と migration-notice（コードを実行しない）
    expect(tokenJobs.map((job) => job.id)).toEqual(['impact', 'unit', 'migration-notice']);
    for (const job of tokenJobs) {
      const effective = readPermissions(job.lines, 4) ?? workflowPermissions;
      if (repositoryCodeMarkers(job).length > 0) {
        expect(hasWrite(effective), `${job.id} は write 権限の token でコードを実行する`).toBe(
          false,
        );
      }
    }
  });

  it('unit job は read-only で、検知結果を job output へ出すだけ', () => {
    const unit = jobById('unit');

    expect(readPermissions(unit.lines, 4)).toEqual({
      inline: '',
      scopes: { contents: 'read', 'pull-requests': 'read' },
    });
    expect(unit.text).toContain(
      'migration_destructive: ${{ steps.run.outputs.migration_destructive }}',
    );
    expect(unit.text).toContain(
      'migration_comment_b64: ${{ steps.run.outputs.migration_comment_b64 }}',
    );
    expect(unit.text).toMatch(/^\s+id: run$/m);
  });

  it('migration-notice job は repo のコードを実行せず、unit の失敗時も走り、required check ではない', () => {
    const notice = jobById('migration-notice');

    expect(repositoryCodeMarkers(notice)).toEqual([]);
    expect(notice.text).not.toMatch(/^\s*(-\s+)?uses:/m);
    expect(readPermissions(notice.lines, 4)?.scopes).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
    });
    expect(notice.text).toMatch(/^ {4}needs: unit$/m);
    const condition = notice.text.match(/^ {4}if: (.+)$/m)?.[1] ?? '';
    // coupled migration で unit が落ちた PR こそ通知が要る。success() 既定だと skip される
    expect(condition).toContain('!cancelled()');
    expect(condition).toContain("needs.unit.outputs.migration_destructive == 'true'");
    // unit output（PR head のコードが書いた値）を run script へ `${{ }}` で展開しない
    expect(runScriptOf(notice)).not.toContain('${{');

    const displayName = notice.text.match(/^ {4}name: (.+)$/m)?.[1] ?? '';
    expect(displayName).toBe('Migration Safety Notice');
    expect(FINISH_BRANCH).not.toContain(displayName);
  });

  describe('回帰確認', () => {
    it('write 権限を持ったまま setup を走らせる旧 unit job の形を検出する', () => {
      const regressed = [
        'permissions:',
        '  contents: read',
        '  pull-requests: read',
        'jobs:',
        '  unit:',
        '    permissions:',
        '      contents: read',
        '      pull-requests: write',
        '      issues: write',
        '    steps:',
        '      - uses: actions/checkout@abc # v7',
        '        with:',
        '          persist-credentials: false',
        '      - uses: ./.github/actions/setup',
        '      - name: Run unit tests',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '        run: node scripts/ci/check.mjs unit',
      ].join('\n');

      expect(writeTokenOffenders(regressed)).toEqual([
        'unit: write token + checkout, local action, node',
        'unit: write token + uses',
      ]);
    });

    it('job 単位の宣言が無ければ workflow 単位の write-all を継承したものとして検出する', () => {
      const regressed = [
        'permissions: write-all',
        'jobs:',
        '  static:',
        '    steps:',
        '      - run: pnpm install --frozen-lockfile',
      ].join('\n');

      expect(writeTokenOffenders(regressed)).toEqual(['static: write token + package manager']);
    });

    it('permissions 宣言がどこにも無い job は write 扱い（fail closed）', () => {
      const regressed = ['jobs:', '  a:', '    steps:', '      - run: npx something'].join('\n');

      expect(writeTokenOffenders(regressed)).toEqual(['a: write token + package manager']);
    });

    it('コメント中の pnpm / write では判定が動かない', () => {
      const fine = [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  notice:',
        '    # pnpm install はしない。pull-requests: write はここだけ',
        '    permissions:',
        '      issues: write',
        '    steps:',
        '      - run: gh api repos/x/y',
      ].join('\n');

      expect(writeTokenOffenders(fine)).toEqual([]);
    });

    it('実ファイルから 5 job を読めている（切り出しの空振りで全 assert が素通りしない）', () => {
      expect(ciJobs.map((job) => job.id)).toEqual([
        'impact',
        'static',
        'unit',
        'migration-notice',
        'integration',
      ]);
    });
  });
});

// ─── migration-notice job の run script を偽 gh で実行する ─────────────

/** job 内の `run: |` block scalar を取り出して dedent する。 */
function runScriptOf(job: Job): string {
  const lines = CI_YML.split('\n');
  const headerIndex = lines.findIndex((line) => line === `  ${job.id}:`);
  const runIndex = lines.findIndex(
    (line, index) => index > headerIndex && /^ +run: \|$/.test(line),
  );
  if (headerIndex === -1 || runIndex === -1) throw new Error(`${job.id} に run: | が無い`);
  const bodyIndent = indentOf(lines[runIndex]) + 2;
  const body: string[] = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== '' && indentOf(line) < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join('\n');
}

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = api ] && [ "$2" != --method ]; then
  [ "\${FAKE_LABELS_FAIL:-}" = 1 ] && exit 1
  echo "\${FAKE_HAS_LABEL:-false}"
  exit 0
fi
if [ "$1" = pr ] && [ "$2" = comment ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then cat "$2" > "$GH_BODY"; fi
    shift
  done
  exit "\${FAKE_COMMENT_STATUS:-0}"
fi
exit 0
`;

describe('migration-notice job の run script', () => {
  // collection 時に取り出すと、job が消えた時に上の invariant test まで巻き込んで
  // 「no tests」になり、どの保証が崩れたかが読めなくなるため、各 test の中で取り出す。
  const script = () => runScriptOf(jobById('migration-notice'));
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const SUMMARY = '## Migration safety\n\n`DROP TABLE` を検知\n$(touch pwned)\nEOF\n';
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  function runNotice(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-migration-notice-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'notice.sh'), script());
    // GitHub Actions の既定 shell（bash --noprofile --norc -eo pipefail {0}）に揃える
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'notice.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GH_LOG: join(dir, 'gh.log'),
        GH_BODY: join(dir, 'body.md'),
        RUNNER_TEMP: dir,
        GH_TOKEN: 'fake',
        GH_REPO: 'Dayopt/dayopt',
        PR_NUMBER: '7',
        MIGRATION_DESTRUCTIVE: 'true',
        MIGRATION_COMMENT_B64: b64(SUMMARY),
        ...env,
      },
    });
    const log = existsSync(join(dir, 'gh.log'))
      ? readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n')
      : [];
    const body = existsSync(join(dir, 'body.md'))
      ? readFileSync(join(dir, 'body.md'), 'utf8')
      : null;
    return { ...result, log, body, dir };
  }

  it('未付与ならラベル作成 → コメント投稿 → ラベル付与の順で通知し、本文は decode した summary そのもの', () => {
    const result = runNotice({});

    expect(result.status).toBe(0);
    expect(result.log).toEqual([
      'api repos/Dayopt/dayopt/issues/7/labels --jq [.[] | select(.name == "db:destructive-migration")] | length > 0',
      'label create db:destructive-migration --repo Dayopt/dayopt --color B60205 --description 破壊的 migration を検知（EXPLICIT AUTHORITY 要確認）',
      `pr comment 7 --repo Dayopt/dayopt --body-file ${join(result.dir, 'migration-safety-comment.md')}`,
      'api --method POST repos/Dayopt/dayopt/issues/7/labels -f labels[]=db:destructive-migration',
    ]);
    expect(result.body).toBe(SUMMARY);
    // 本文はシェルに評価されない
    expect(existsSync(join(result.dir, 'pwned'))).toBe(false);
  });

  it('付与済みなら再通知しない', () => {
    const result = runNotice({ FAKE_HAS_LABEL: 'true' });

    expect(result.status).toBe(0);
    expect(result.log).toHaveLength(1);
    expect(result.body).toBeNull();
  });

  it('ラベル確認の gh api が失敗しても fail open で通知する', () => {
    const result = runNotice({ FAKE_LABELS_FAIL: '1' });

    expect(result.status).toBe(0);
    expect(result.log.some((line) => line.startsWith('pr comment 7'))).toBe(true);
    expect(result.log.some((line) => line.startsWith('api --method POST'))).toBe(true);
  });

  it('コメント投稿が失敗（fork PR の read-only token 等）したらラベルは付与せず、job も落とさない', () => {
    const result = runNotice({ FAKE_COMMENT_STATUS: '1' });

    expect(result.status).toBe(0);
    expect(result.log.some((line) => line.startsWith('api --method POST'))).toBe(false);
    expect(result.stdout).toContain('::warning::migration safety のコメント投稿に失敗しました');
  });

  it.each(['TRUE', 'false', '', 'true\n', ' true'])(
    'MIGRATION_DESTRUCTIVE=%j は true 完全一致ではないため gh を呼ばない',
    (value) => {
      const result = runNotice({ MIGRATION_DESTRUCTIVE: value });

      expect(result.status).toBe(0);
      expect(result.log).toEqual([]);
    },
  );

  it.each(['', 'not base64!', 'YWJj\nmigration_destructive=true', 'YWJjZA=', '$(touch pwned)'])(
    'コメント本文の output %j が base64 として不正なら gh を呼ばない',
    (value) => {
      const result = runNotice({ MIGRATION_COMMENT_B64: value });

      expect(result.status).toBe(0);
      expect(result.log).toEqual([]);
      expect(result.stdout).toContain('::warning::');
      expect(existsSync(join(result.dir, 'pwned'))).toBe(false);
    },
  );

  it.each<Record<string, string>>([
    { PR_NUMBER: '' },
    { PR_NUMBER: '7; echo x' },
    { GH_REPO: 'Dayopt/dayopt/../x y' },
  ])('PR 番号 / repo が不正（%j）なら gh を呼ばない', (env) => {
    const result = runNotice(env);

    expect(result.status).toBe(0);
    expect(result.log).toEqual([]);
  });
});
