import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `finish-branch.sh` は Claude / 人間で共通のマージゲートで、判定を誤ると
 * 「失敗を見落としてマージする」方向に倒れる。実スクリプトを子プロセスで動かし、
 * `gh` だけ stub して check 判定の分岐を固定する。
 *
 * とくに **同一 head SHA に複数 run が積まれた rollup** を正しく畳めているかを見る。
 * `gh pr view --json statusCheckRollup` は同名 check を畳まないため（`gh pr checks` は畳む）、
 * 畳まずに数えると再実行で解決済みの failure を永久に数え続けてマージ不能になる。
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = join(rootDir, 'scripts/tasks/finish-branch.sh');
const temporaryDirectories: string[] = [];

const BRANCH = 'claude/example-branch-1';

type RollupEntry = Record<string, unknown>;

function checkRun(
  name: string,
  conclusion: string | null,
  startedAt: string | null,
  status = 'COMPLETED',
  workflowName = 'CI',
): RollupEntry {
  return {
    __typename: 'CheckRun',
    name,
    workflowName,
    conclusion,
    status,
    startedAt,
    completedAt: startedAt,
    detailsUrl: 'https://example.test/run',
  };
}

function statusContext(context: string, state: string, startedAt: string): RollupEntry {
  return {
    __typename: 'StatusContext',
    context,
    state,
    startedAt,
    targetUrl: 'https://example.test',
  };
}

/**
 * merge gate が **名前で存在と success を要求する** check 一式。合格を期待する
 * ケースの rollup には必ず足す。
 *
 * - Vercel の 2 context: Actions 側の無条件 build を撤去し、product / web の
 *   build 検証が Vercel にしか無いため（#1813）
 * - Static Checks / Unit Tests: draft 中は ci.yml が skip するため、skipped の
 *   まま merge へ抜ける経路を塞ぐ（#2415）。**Static Checks は docs-only でも
 *   免除しない**（#2483 で secret/docs 検査が static job へ吸収され、docs-only
 *   PR でも唯一の実行経路になったため。内製クロスレビュー risk-reviewer
 *   指摘、P1、PR #2484）。Unit Tests だけ docs-only PR で免除される
 * - Integration Tests（#2539 で分離）は **integration affected な PR でだけ**
 *   要求される。affected でない PR では rollup に無くても通るため、合格を
 *   期待するケースでは常に足しておいて構わない（要求されない check が
 *   余分に存在しても gate は名前で success を見るだけ）
 */
function requiredChecks(): RollupEntry[] {
  return [
    statusContext('Vercel – product', 'SUCCESS', '2026-07-30T10:00:00Z'),
    statusContext('Vercel – web', 'SUCCESS', '2026-07-30T10:00:00Z'),
    ...ciChecks(),
  ];
}

/**
 * ci.yml の 3 job。draft skip（#2415）で名前指定の要求対象になった。
 * Integration Tests は #2539 の job 分割で加わった（affected な PR でだけ要求される
 * が、ここでは常に足す。上の requiredChecks() のコメント参照）。
 */
function ciChecks(conclusion = 'SUCCESS'): RollupEntry[] {
  return [
    checkRun('🔍 Static Checks', conclusion, '2026-07-30T10:00:00Z'),
    checkRun('📦 Unit Tests', conclusion, '2026-07-30T10:00:00Z'),
    checkRun('🧪 Integration Tests', conclusion, '2026-07-30T10:00:00Z'),
  ];
}

/** ciChecks() から 1 つだけ落とす（「その check が欠けたら止まる」を固定する用）。 */
function ciChecksWithout(name: string, conclusion = 'SUCCESS'): RollupEntry[] {
  return ciChecks(conclusion).filter((entry) => (entry.name as string) !== name);
}

/** レビュー thread の GraphQL レスポンスを組み立てる（shape は gh api graphql の実出力） */
function threadsPayload(
  threads: Array<{ isResolved: boolean; path?: string; author?: string }>,
  hasNextPage = false,
  endCursor: string | null = null,
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes: threads.map((thread) => ({
              isResolved: thread.isResolved,
              path: thread.path ?? 'src/example.ts',
              comments: {
                nodes: [{ author: { login: thread.author ?? 'chatgpt-codex-connector' } }],
              },
            })),
          },
        },
      },
    },
  };
}

/** PR JSON が常に申告する headRefOid（このテストファイル内で固定値として扱う） */
const DEFAULT_HEAD_SHA = '0'.repeat(40);

/** N 件の resolve 済み thread を作る（ページング境界の件数合わせ用） */
function resolvedThreads(count: number): Array<{ isResolved: boolean }> {
  return Array.from({ length: count }, () => ({ isResolved: true }));
}

function runScript(
  rollup: RollupEntry[],
  options: {
    compare?: string;
    isDraft?: boolean;
    /** PR の変更ファイル一覧。省略時は product / web 両方に触れる形（従来テストの前提を維持） */
    files?: string[];
    /** rename の移動元（previous_filename）。API は移動先を filename で返す */
    previousFiles?: string[];
    /** PR の changedFiles 申告値。省略時は files の件数（= 一致して gate を通る） */
    changedFilesCount?: number;
    /** 変更ファイル一覧 API を失敗させる（fail closed 経路の検証） */
    filesUnavailable?: boolean;
    /** 一覧を部分的に出力した後で失敗させる（pagination 途中失敗の再現） */
    filesPartialFailure?: boolean;
    /** レビュー thread の状態（1 ページ目のみ）。省略時は 0 件（gate を通す） */
    threads?: Array<{ isResolved: boolean; path?: string; author?: string }>;
    /** thread 取得 API を失敗させる（fail closed 経路の検証） */
    threadsUnavailable?: boolean;
    /** reviewThreads の 1 ページ目が hasNextPage: true で終わり、2 ページ目を用意しない状態にする */
    threadsTruncated?: boolean;
    /**
     * commit status「Production Config Audit」の description。audit contract guard の
     * failure が設計上のもの（`Audit contract changed; …`）か本物の drift
     * （`Vercel metadata does not match …`）かを決める唯一の手がかり。
     * 省略時は設計上の failure（= advisory になる形）。
     */
    auditStatusDescription?: string;
    /** status 取得 API を失敗させる（description 不明の fail closed 経路の検証） */
    auditStatusUnavailable?: boolean;
    /**
     * reviewThreads を複数ページに分けてレスポンスを組み立てる。指定時は `threads` /
     * `threadsTruncated` より優先する。各要素が 1 ページ分。`hasNextPage` を省略した
     * 要素は「最後の要素以外は true、最後は false」として扱う（20 ページ上限の
     * テストのように全ページ true にしたい場合だけ明示する）。
     */
    threadPages?: Array<{
      threads?: Array<{ isResolved: boolean; path?: string; author?: string }>;
      hasNextPage?: boolean;
    }>;
  } = {},
): { status: number | null; stderr: string; auditStatusArgs: string } {
  // repo 直下ではなく os の temp に作る。プロセスが afterEach 前に落ちると untracked な
  // ディレクトリが repo に残り、まさにこのスクリプトの dirty ゲートが以後の掃除を止める。
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'finish-branch-test-'));
  temporaryDirectories.push(temporaryDirectory);

  const binDirectory = join(temporaryDirectory, 'bin');
  mkdirSync(binDirectory);

  const changedFiles = options.files ?? ['apps/product/src/app.ts', 'apps/web/src/page.tsx'];
  const previousFiles = options.previousFiles ?? [];

  const payloadPath = join(temporaryDirectory, 'pr.json');
  writeFileSync(
    payloadPath,
    JSON.stringify({
      state: 'OPEN',
      isDraft: options.isDraft ?? false,
      headRefName: BRANCH,
      headRefOid: DEFAULT_HEAD_SHA,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: rollup,
      changedFiles: options.changedFilesCount ?? changedFiles.length,
      labels: [],
    }),
  );

  // PR の変更ファイル一覧（impact 判定の入力）。既定は product / web 両方に触れる形。
  // 実際の gh は `F<TAB>filename` / `P<TAB>previous_filename` の形で出す（rename の
  // 移動元を落とさず、かつ「ファイル件数」を数えられるようにするため）。
  const filesPath = join(temporaryDirectory, 'files.txt');
  writeFileSync(
    filesPath,
    options.filesUnavailable
      ? ''
      : `${[
          ...changedFiles.map((file) => `F\t${file}`),
          ...previousFiles.map((file) => `P\t${file}`),
        ].join('\n')}\n`,
  );

  // レビュー thread の GraphQL レスポンス（ページ単位）。gh スタブは cursor 引数
  // （page-N.json の N）でページを選ぶため、実際のディレクトリに 1..N の
  // page-*.json を並べる。threadsUnavailable は実在しないディレクトリを指させて
  // cat を失敗させる（API 不通の再現）。
  const threadsDirectory = join(temporaryDirectory, 'threads');
  mkdirSync(threadsDirectory);

  const pages =
    options.threadPages ??
    ([
      { threads: options.threads ?? [], hasNextPage: options.threadsTruncated ?? false },
    ] satisfies Array<{
      threads: Array<{ isResolved: boolean; path?: string; author?: string }>;
      hasNextPage: boolean;
    }>);

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const isLast = index === pages.length - 1;
    const hasNextPage = page.hasNextPage ?? !isLast;
    // 次ページの cursor はそのページ番号の文字列にする。gh スタブはこの値を
    // そのまま `page-<cursor>.json` の解決に使う。
    const endCursor = hasNextPage ? String(pageNumber + 1) : null;
    writeFileSync(
      join(threadsDirectory, `page-${pageNumber}.json`),
      JSON.stringify(threadsPayload(page.threads ?? [], hasNextPage, endCursor)),
    );
  });

  // `gh` だけ差し替える。git は temp repo 上で本物を動かす（worktree / show-ref の判定を
  // 実挙動に任せる方が、stub の作り込みより契約に近い）。
  //
  // 内製 marker / Codex 証跡の gate は #2596 で削除した。gh スタブが応答すべき
  // graphql クエリは reviewThreads（ページング）だけになった。
  const ghStub = join(binDirectory, 'gh');
  writeFileSync(
    ghStub,
    `#!/bin/bash
set -euo pipefail
case "$1" in
  pr)
    case "\${2:-}" in
      view) cat "$FINISH_BRANCH_PR_JSON" ;;
      *) exit 2 ;;
    esac
    ;;
  api)
    shift
    if [[ "\${1:-}" == graphql ]]; then
      # cursor 引数（-f cursor=VALUE）を argv から拾う。無ければ 1 ページ目。
      cursor=""
      for arg in "$@"; do
        case "$arg" in
          cursor=*) cursor="\${arg#cursor=}" ;;
        esac
      done
      if [[ -n "$cursor" ]]; then
        cat "$FINISH_BRANCH_THREADS_DIR/page-\${cursor}.json"
      else
        cat "$FINISH_BRANCH_THREADS_DIR/page-1.json"
      fi
    else
      case "$*" in
        *commits/*/statuses*)
          # 実 gh は --jq が description を 1 行ずつ出す（新しい順）。空なら 1 件も無い状態。
          # 呼び出し形は pagination 契約の test が読むので記録する。
          printf '%s\n' "$*" >> "$FINISH_BRANCH_AUDIT_STATUS_ARGS"
          if [[ "\${FINISH_BRANCH_AUDIT_STATUS_EXIT:-0}" != "0" ]]; then exit 1; fi
          if [[ -n "\${FINISH_BRANCH_AUDIT_STATUS_DESCRIPTION:-}" ]]; then
            printf '%s\n' "\${FINISH_BRANCH_AUDIT_STATUS_DESCRIPTION}"
          fi
          ;;
        *pulls/123/files*)
          cat "$FINISH_BRANCH_PR_FILES"
          if [[ "\${FINISH_BRANCH_FILES_EXIT:-0}" != "0" ]]; then exit 1; fi
          ;;
        *compare*) echo "$FINISH_BRANCH_COMPARE" ;;
        *full_name*) echo "Dayopt/dayopt" ;;
        *) exit 2 ;;
      esac
    fi
    ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(ghStub, 0o755);

  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: temporaryDirectory, encoding: 'utf8' });

  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(temporaryDirectory, 'seed.txt'), 'seed\n');
  git('add', 'seed.txt');
  git('commit', '-m', 'seed');

  const auditStatusArgsPath = join(temporaryDirectory, 'audit-status-args.txt');

  const result = spawnSync('bash', [scriptPath, '123', '--dry-run'], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      FINISH_BRANCH_PR_JSON: payloadPath,
      FINISH_BRANCH_COMPARE: options.compare ?? 'ahead',
      FINISH_BRANCH_PR_FILES: options.filesUnavailable
        ? join(temporaryDirectory, 'missing-files.txt')
        : filesPath,
      FINISH_BRANCH_THREADS_DIR: options.threadsUnavailable
        ? join(temporaryDirectory, 'missing-threads-dir')
        : threadsDirectory,
      FINISH_BRANCH_FILES_EXIT: options.filesPartialFailure ? '1' : '0',
      FINISH_BRANCH_AUDIT_STATUS_DESCRIPTION:
        options.auditStatusDescription ?? 'Audit contract changed; trusted head audit is required',
      FINISH_BRANCH_AUDIT_STATUS_EXIT: options.auditStatusUnavailable ? '1' : '0',
      FINISH_BRANCH_AUDIT_STATUS_ARGS: auditStatusArgsPath,
    },
  });

  return {
    status: result.status,
    stderr: result.stderr ?? '',
    /** statuses API を呼んだ時の gh の引数（1 行 1 回）。pagination 契約の検証用 */
    auditStatusArgs: existsSync(auditStatusArgsPath)
      ? readFileSync(auditStatusArgsPath, 'utf8')
      : '',
  };
}

/**
 * 実 git 上で step 3-9 を動かす harness（`--dry-run` なし）。
 *
 * 上の `runScript` は check ゲートの分岐を見るためのもので、掃除本体は dry-run のまま
 * 素通りする。#1771 の 3 症状（gh が実行元 worktree を切り替える / `checkout main` が
 * 別セッションの作業を奪う / `branch -d` が HEAD 基準で偽陰性を出す）は **実 git の
 * worktree 構成でしか再現しない**ため、bare origin + 複数 worktree を組んで実挙動を固定する。
 *
 * PR state は MERGED / CLOSED を返してマージ手順ごと skip させる。ここで見たいのは
 * マージ判定ではなく掃除側の挙動で、`gh api` が呼ばれたら stub が落ちて気づける。
 */
type RepoScenario = {
  /** MERGED ならマージ済み、CLOSED なら「未マージのまま閉じた」経路、OPEN ならマージから走る */
  prState: 'OPEN' | 'MERGED' | 'CLOSED';
  /** OPEN のとき、マージ API を失敗させる */
  mergeFails?: boolean;
  /** origin/main に feature を merge --no-ff 済みにするか */
  mergeIntoMain: boolean;
  /** MAIN_ROOT の HEAD。'other' は別セッションが作業中の状態を表す */
  mainRootHead: 'main' | 'other' | 'feature';
  dirtyFeature?: boolean;
  /** main を MAIN_ROOT 以外の worktree が checkout している状態にする */
  addMainWorktree?: boolean;
  /** feature branch の worktree を作る */
  addFeatureWorktree?: boolean;
  /** script の実行位置 */
  runFrom?: 'main-root' | 'feature-worktree';
};

function runScriptOnRepo(scenario: RepoScenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-branch-repo-')));
  temporaryDirectories.push(root);

  const originPath = join(root, 'origin.git');
  const seeder = join(root, 'seeder');
  const mainRoot = join(root, 'mainroot');
  const mainWorktree = join(root, 'wt-main');
  const featureWorktree = join(root, 'wt-feature');

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} @ ${cwd}\n${result.stderr}`);
    }
    return (result.stdout ?? '').trim();
  };
  const gitStatus = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8' }).status;

  git(root, 'init', '--bare', '--initial-branch=main', originPath);

  git(root, 'clone', originPath, seeder);
  git(seeder, 'config', 'user.email', 'test@example.com');
  git(seeder, 'config', 'user.name', 'test');
  writeFileSync(join(seeder, 'seed.txt'), 'seed\n');
  git(seeder, 'add', 'seed.txt');
  git(seeder, 'commit', '-m', 'seed');
  git(seeder, 'push', 'origin', 'main');

  git(seeder, 'checkout', '-b', BRANCH);
  writeFileSync(join(seeder, 'feature.txt'), 'feature\n');
  git(seeder, 'add', 'feature.txt');
  git(seeder, 'commit', '-m', 'feature');
  git(seeder, 'push', 'origin', BRANCH);
  git(seeder, 'checkout', 'main');

  // MAIN_ROOT はマージ前に clone する。「リモートはマージ済みだがローカル main は古い」
  // という実運用の状態を作るため。
  git(root, 'clone', originPath, mainRoot);
  git(mainRoot, 'config', 'user.email', 'test@example.com');
  git(mainRoot, 'config', 'user.name', 'test');
  // Claude Code が作る worktree branch は upstream 追跡を持たないことが多い。同じ形にする。
  git(mainRoot, 'fetch', 'origin', `${BRANCH}:${BRANCH}`);

  if (scenario.mainRootHead === 'other') {
    git(mainRoot, 'checkout', '-b', 'other');
  }
  if (scenario.mainRootHead === 'feature') {
    git(mainRoot, 'checkout', BRANCH);
    if (scenario.dirtyFeature) writeFileSync(join(mainRoot, 'feature.txt'), 'uncommitted\n');
  }
  if (scenario.addMainWorktree) {
    git(mainRoot, 'worktree', 'add', mainWorktree, 'main');
  }
  if (scenario.addFeatureWorktree) {
    git(mainRoot, 'worktree', 'add', featureWorktree, BRANCH);
  }

  if (scenario.mergeIntoMain) {
    git(seeder, 'merge', '--no-ff', BRANCH, '-m', `Merge pull request #123 from ${BRANCH}`);
    git(seeder, 'push', 'origin', 'main');
  }

  const binDirectory = join(root, 'bin');
  mkdirSync(binDirectory);
  const headSha = git(seeder, 'rev-parse', BRANCH);
  const payloadPath = join(root, 'pr.json');
  writeFileSync(
    payloadPath,
    JSON.stringify({
      state: scenario.prState,
      isDraft: false,
      headRefName: BRANCH,
      headRefOid: headSha,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup:
        scenario.prState === 'OPEN'
          ? [checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'), ...requiredChecks()]
          : [],
      changedFiles: 2,
    }),
  );

  // OPEN 以外ではマージ手順が skip される。gh api が呼ばれたら失敗させて気づけるようにする。
  const ghStub = join(binDirectory, 'gh');
  writeFileSync(
    ghStub,
    `#!/bin/bash
set -euo pipefail
case "$1" in
  pr) cat "$FINISH_BRANCH_PR_JSON" ;;
  api)
    if [[ "\${FINISH_BRANCH_EXPECT_MERGE:-0}" != "1" ]]; then
      echo "unexpected gh api call: $*" >&2
      exit 2
    fi
    case "$*" in
      *graphql*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}' ;;
      *full_name*) echo "Dayopt/dayopt" ;;
      *pulls/123/files*) printf 'F\\tapps/product/src/x.ts\\nF\\tapps/web/src/y.ts\\n' ;;
      *compare*) echo ahead ;;
      */merge*) exit "\${FINISH_BRANCH_MERGE_EXIT:-0}" ;;
      *) exit 0 ;;
    esac
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(ghStub, 0o755);

  const result = spawnSync('bash', [scriptPath, '123'], {
    cwd: scenario.runFrom === 'feature-worktree' ? featureWorktree : mainRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      FINISH_BRANCH_PR_JSON: payloadPath,
      FINISH_BRANCH_EXPECT_MERGE: scenario.prState === 'OPEN' ? '1' : '0',
      FINISH_BRANCH_MERGE_EXIT: scenario.mergeFails ? '1' : '0',
    },
  });

  return {
    status: result.status,
    stderr: result.stderr ?? '',
    mainRoot,
    mainWorktree,
    featureWorktree,
    branchExists: () =>
      gitStatus(mainRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`) === 0,
    currentBranch: (cwd: string) => git(cwd, 'branch', '--show-current'),
    localMainMatchesRemote: () =>
      git(mainRoot, 'rev-parse', 'main') === git(mainRoot, 'rev-parse', 'origin/main'),
    remoteBranchExists: () => git(mainRoot, 'ls-remote', '--heads', 'origin', BRANCH) !== '',
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('同一 SHA に積まれた重複 check の畳み込み', () => {
  it('古い failure が新しい success に置き換わっていればマージへ進む', () => {
    // ラベル付与 / draft→ready / 手動 re-run で 2 本目が走った後の形。
    // 畳まないと解決済みの failure を数えて永久にマージ不能になる。
    const { status, stderr } = runScript([
      checkRun('CI', 'FAILURE', '2026-07-30T10:00:00Z'),
      checkRun('CI', 'SUCCESS', '2026-07-30T10:10:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(status).toBe(0);
  });

  it('cancelled になった古い run も新しい success で解消される', () => {
    // cancel-in-progress で 1 本目が cancelled になる経路（draft→ready 等）。
    const { status, stderr } = runScript([
      checkRun('CI', 'CANCELLED', '2026-07-30T10:00:00Z'),
      checkRun('CI', 'SUCCESS', '2026-07-30T10:10:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(status).toBe(0);
  });

  it('新しい run が failure なら止める（古い success で上書きしない）', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      checkRun('CI', 'FAILURE', '2026-07-30T10:10:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('実行中の run が 1 つでもあれば止める（startedAt が無くても）', () => {
    // queued な run は startedAt を持たないことがある。「最新」を startedAt だけで
    // 決めると古い完了 run が勝ち、実行中を見落として素通りする（fail-open）。
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      checkRun('CI', null, null, 'QUEUED'),
    ]);
    expect(stderr).toContain('実行中の check');
    expect(status).toBe(1);
  });

  it('StatusContext と CheckRun が混在しても名前ごとに畳む', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'FAILURE', '2026-07-30T10:00:00Z'),
      checkRun('CI', 'SUCCESS', '2026-07-30T10:10:00Z'),
      statusContext('Vercel – product', 'SUCCESS', '2026-07-30T10:11:00Z'),
      statusContext('Vercel – web', 'SUCCESS', '2026-07-30T10:11:00Z'),
      ...ciChecks(),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(status).toBe(0);
  });
});

describe('畳み込みが失敗を消さないこと', () => {
  it('後から積まれた skipped で古い failure を消さない', () => {
    // job-level `if:` で skip された run は同一 SHA に conclusion: skipped の check run を
    // 作る（ci.yml の重量 job は draft PR で skip する）。skipped は失敗にも成功にも数えないため、
    // これを代表に選ぶと blocking な赤が消える。実在する経路:
    // ready で FAILURE → draft へ戻す → close → reopen（draft なので skip）。
    const { status, stderr } = runScript([
      checkRun('🎭 E2E Tests', 'FAILURE', '2026-07-30T10:00:00Z', 'COMPLETED', 'CI'),
      checkRun('🎭 E2E Tests', 'SKIPPED', '2026-07-30T10:10:00Z', 'COMPLETED', 'CI'),
      checkRun('docs guard', 'SUCCESS', '2026-07-30T10:01:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('後から積まれた skipped で古い success も消さない', () => {
    // 逆方向。skipped を代表にすると「成功 1 件以上」を割って別の理由で止まる。
    const { status, stderr } = runScript([
      checkRun('🎭 E2E Tests', 'SUCCESS', '2026-07-30T10:00:00Z', 'COMPLETED', 'CI'),
      checkRun('🎭 E2E Tests', 'SKIPPED', '2026-07-30T10:10:00Z', 'COMPLETED', 'CI'),
      ...requiredChecks(),
    ]);
    expect(stderr).not.toContain('成功した check が 1 件もありません');
    expect(status).toBe(0);
  });

  it('別名の古い failure を新しい success で畳まない', () => {
    // 「name を見ずに rollup 全体から startedAt 最大の 1 件だけ残す」実装だと
    // ここで failure が消える。group key が効いていることを固定する。
    const { status, stderr } = runScript([
      checkRun('CI', 'FAILURE', '2026-07-30T10:00:00Z'),
      checkRun('E2E', 'SUCCESS', '2026-07-30T10:10:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('同名でも workflow が違えば畳まない', () => {
    // gh pr checks の dedupe は name + workflow。name だけで畳むと、別 workflow の
    // 同名 job の failure が新しい成功に隠れる。
    const { status, stderr } = runScript([
      checkRun('Integration Tests', 'FAILURE', '2026-07-30T10:00:00Z', 'COMPLETED', 'A'),
      checkRun('Integration Tests', 'SUCCESS', '2026-07-30T10:10:00Z', 'COMPLETED', 'B'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });
});

describe('audit contract guard の advisory 扱い（#2469）', () => {
  // production-config-audit.yml は audit contract 保護対象を変更する PR で
  // check run「Audit Vercel metadata (trusted)」を **設計として必ず failure にする**。
  // この failure は「contract 4 path を触った」という事実だけを表し、diff の良し悪しを
  // 一切表していない。本物の監査結果は workflow_dispatch run 側にあり rollup に載らない。
  //
  // 2026-09-18（#2469）に、この guard を shadow status と同じ advisory へ格下げした。
  // merge の遮断は main の ruleset 1 本（#2640）で、そこに `Production Config Audit` は
  // 無く、この checkpoint は branch:finish だけに効く非対称な gate だった。
  const guardFailure = (workflowName = 'Production Config Audit') =>
    checkRun(
      'Audit Vercel metadata (trusted)',
      'FAILURE',
      '2026-08-03T00:25:00Z',
      'COMPLETED',
      workflowName,
    );

  it('status success が無くても guard の failure では止まらない', () => {
    // 撤去前はここで「trusted dispatch が必要です」と exit 1 していた（#2571）。
    const { status, stderr } = runScript([
      guardFailure(),
      checkRun('CI', 'SUCCESS', '2026-08-03T00:20:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).toContain('advisory として扱い');
    expect(stderr).not.toContain('失敗している check');
    expect(stderr).not.toContain('trusted dispatch が必要');
    expect(status).toBe(0);
  });

  it('status「Production Config Audit」の failure でも止まらない', () => {
    // dispatch 未実行の contract 変更 PR では status も failure（"trusted head audit is
    // required"）のまま残る。guard と同じ発行元の advisory なので数えない。
    const { status, stderr } = runScript([
      guardFailure(),
      statusContext('Production Config Audit', 'FAILURE', '2026-08-03T00:25:36Z'),
      checkRun('CI', 'SUCCESS', '2026-08-03T00:20:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(status).toBe(0);
  });

  it('guard が cancelled / timed_out でも止まらない', () => {
    // 免除ではなく advisory なので、conclusion の種別で分岐しない。監査の完走は
    // push:main / nightly / promote の runProductionConfigAudit が担保する。
    const { status } = runScript([
      checkRun(
        'Audit Vercel metadata (trusted)',
        'CANCELLED',
        '2026-08-03T00:25:00Z',
        'COMPLETED',
        'Production Config Audit',
      ),
      checkRun('CI', 'SUCCESS', '2026-08-03T00:20:00Z'),
      ...requiredChecks(),
    ]);
    expect(status).toBe(0);
  });

  // ── ここから先は「緩めていない」ことの負例。advisory 判定は 型 + workflow 名 +
  // check 名 / context の完全一致のみで、それ以外の failure は従来どおり merge を止める。
  it('同名 check でも workflow が違えば advisory にしない', () => {
    // name だけで advisory 判定すると、別 workflow が同名 job を持った時に本物の
    // failure が消える。
    const { status, stderr } = runScript([guardFailure('CI'), ...requiredChecks()]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('同じ workflow の別 job の failure は止める', () => {
    // advisory にするのは pull_request_target が必ず落とす guard job だけ。
    // 同じ workflow の別 job（例: 実監査 job）が落ちたら従来どおり止まる。
    const { status, stderr } = runScript([
      checkRun(
        'Audit Vercel metadata',
        'FAILURE',
        '2026-08-03T00:25:00Z',
        'COMPLETED',
        'Production Config Audit',
      ),
      ...requiredChecks(),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  // ── 本物の drift は advisory にしない ──────────────────────────────────
  // workflow の `Enforce audit result` は「contract を変えた（設計上の failure）」でも
  // 「Vercel の env metadata が Production contract と食い違う（本物の drift）」でも
  // exit 1 する。conclusion / state では区別できず、status の description だけが分ける。
  it('status description が本物の drift を報告していたら止める', () => {
    const { status, stderr } = runScript(
      [guardFailure(), statusContext('Production Config Audit', 'FAILURE', '2026-08-03T00:25:36Z')],
      { auditStatusDescription: 'Vercel metadata does not match the Production contract' },
    );
    expect(stderr).toContain('allowlist と一致しません');
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  // 既定を advisory 側に置くと、workflow が将来 failure 文言を追加した時に本物の失敗が
  // 無言で除外される（#2834 の Codex レビュー P2）。allowlist の完全一致だけを通す。
  // combined status API は既定で先頭 30 件しか返さない。controller の再評価で status が
  // 積み上がると `Production Config Audit` が押し出され、description が空になって
  // fail closed 側へ倒れ、contract 変更 PR の branch:finish が恒久的に止まる。
  // 本 PR 自身の head でも実測 28 件で、上限の手前まで来ていた（#2834 の Codex レビュー P2）。
  it('statuses API を全ページ取得で呼ぶ（先頭 30 件で押し出されない）', () => {
    const { auditStatusArgs } = runScript([guardFailure(), ...requiredChecks()]);
    expect(auditStatusArgs).toContain('--paginate');
    expect(auditStatusArgs).toContain('per_page=100');
  });

  it('未知の description は advisory にしない（allowlist の完全一致のみ）', () => {
    const { status, stderr } = runScript([guardFailure(), ...requiredChecks()], {
      auditStatusDescription: 'Vercel metadata check failed for an unexpected reason',
    });
    expect(stderr).toContain('allowlist と一致しません');
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('advisory の 2 文言は前方一致ではなく完全一致で判定する', () => {
    // 既知文言を含むが末尾に別の理由が付いた description を advisory にしない。
    const { status, stderr } = runScript([guardFailure(), ...requiredChecks()], {
      auditStatusDescription:
        'Vercel metadata matches the Production contract but the project settings drifted',
    });
    expect(stderr).toContain('allowlist と一致しません');
    expect(status).toBe(1);
  });

  it('status description を取得できなければ advisory にしない（fail closed）', () => {
    // 設計上の failure か本物の drift かを判定できない以上、緩める側へ倒さない。
    const { status, stderr } = runScript([guardFailure()], { auditStatusUnavailable: true });
    expect(stderr).toContain('description を取得できませんでした');
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('status が 1 件も無ければ advisory にしない（fail closed）', () => {
    // requiredChecks() を足して「成功 check が 0 件」で落ちる経路を塞ぎ、
    // **guard の failure を数えたこと**が停止の理由であることを固定する。
    const { status, stderr } = runScript([guardFailure(), ...requiredChecks()], {
      auditStatusDescription: '',
    });
    expect(stderr).toContain('description を取得できませんでした');
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('trusted dispatch が通った後（status = matches）も advisory のまま', () => {
    // dispatch を回した PR では設計上の failure の上に成功 status が積まれる。
    const { status, stderr } = runScript(
      [
        guardFailure(),
        statusContext('Production Config Audit', 'SUCCESS', '2026-08-03T00:25:36Z'),
        ...requiredChecks(),
      ],
      { auditStatusDescription: 'Vercel metadata matches the Production contract' },
    );
    expect(stderr).not.toContain('失敗している check');
    expect(status).toBe(0);
  });

  it('guard が advisory でも、同居する他の failure は止める', () => {
    const { status, stderr } = runScript([
      guardFailure(),
      checkRun('CI', 'FAILURE', '2026-08-03T00:20:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });
});

describe('実データの rollup（PR #1765）', () => {
  it('gh pr checks と同じ件数まで畳み、失敗ゼロと判定する', () => {
    // 2026-07-30 に実測した本物の rollup。21 件・8 名前が重複し、gh pr checks は 13 行。
    // stub で作った JSON は shape を仮定してしまうので、実出力で固定する。
    const fixture = JSON.parse(
      readFileSync(
        join(rootDir, 'scripts/__tests__/fixtures/status-check-rollup-duplicated.json'),
        'utf8',
      ),
    ) as { statusCheckRollup: RollupEntry[] };
    expect(fixture.statusCheckRollup).toHaveLength(21);

    // fixture は 2026-07-30 の実測なので、当時まだ分割前だった `📦 Build & Test`
    // を含み、現行の `📦 Unit Tests` を持たない。実データ側は改変せず、名前指定の
    // 要求（#2415）を満たす分だけを足して畳み込みの検証に集中させる。
    const { status, stderr } = runScript([
      ...fixture.statusCheckRollup,
      checkRun('📦 Unit Tests', 'SUCCESS', '2026-07-30T10:20:00Z'),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(stderr).not.toContain('実行中の check');
    expect(status).toBe(0);
  });
});

describe('畳み込みで緩めてはいけない判定', () => {
  it('advisory の shadow status が pending / failure でも required check が揃えば進む', () => {
    const { status, stderr } = runScript([
      ...requiredChecks(),
      statusContext('Review policy (shadow)', 'PENDING', '2026-08-03T10:03:00Z'),
      statusContext('Validation (shadow)', 'FAILURE', '2026-08-03T10:04:00Z'),
    ]);
    expect(stderr).not.toContain('失敗している check');
    expect(stderr).not.toContain('実行中の check');
    expect(status).toBe(0);
  });

  it('単発の failure は従来どおり止める', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      checkRun('E2E', 'FAILURE', '2026-07-30T10:01:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('success が 1 件も無ければ止める（全 skip / check 未登録）', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'SKIPPED', '2026-07-30T10:00:00Z'),
      checkRun('E2E', 'SKIPPED', '2026-07-30T10:01:00Z'),
    ]);
    expect(stderr).toContain('成功した check が 1 件もありません');
    expect(status).toBe(1);
  });

  it('Vercel – product の status が無ければ止める', () => {
    // Actions 側の無条件 build を撤去したため、product の build 検証は Vercel の
    // status にしか存在しない。status が付かない経路（integration 切断・障害、
    // Ignored Build Step、project rename）では「成功 1 件以上」を Static / Unit /
    // Docs Guard だけで満たしてしまい、build を一度も走らせず merge できる。
    const { status, stderr } = runScript([
      checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-03T10:00:00Z'),
      checkRun('📦 Unit Tests', 'SUCCESS', '2026-08-03T10:01:00Z'),
      checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-03T10:02:00Z'),
      statusContext('Vercel – web', 'SUCCESS', '2026-08-03T10:03:00Z'),
    ]);
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('Vercel – product が EXPECTED のままなら止める（存在だけでは通さない）', () => {
    // GitHub の StatusState には EXPECTED（status 到着待ち）があり、これは
    // is_failed にも is_pending にも該当しない。存在だけを見る実装だと
    // 「context はあるが build 未完了」で merge できてしまう。
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-08-03T10:00:00Z'),
      statusContext('Vercel – product', 'EXPECTED', '2026-08-03T10:03:00Z'),
      statusContext('Vercel – web', 'SUCCESS', '2026-08-03T10:03:00Z'),
    ]);
    expect(stderr).toContain('実行中の check');
    expect(status).toBe(1);
  });

  it('Vercel – product が FAILURE なら止める', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-08-03T10:00:00Z'),
      statusContext('Vercel – product', 'FAILURE', '2026-08-03T10:03:00Z'),
      statusContext('Vercel – web', 'SUCCESS', '2026-08-03T10:03:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });

  it('Vercel – web の status が無ければ止める', () => {
    const { status, stderr } = runScript([
      checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-03T10:00:00Z'),
      statusContext('Vercel – product', 'SUCCESS', '2026-08-03T10:03:00Z'),
    ]);
    expect(stderr).toContain('必須 check「Vercel – web」');
    expect(status).toBe(1);
  });

  it('Vercel の context は en dash で照合する（hyphen では一致させない）', () => {
    // context 名は project 名由来で、区切りは U+2013。hyphen を許すと
    // 別名の check を必須扱いしてしまい、検出の意味が消える。
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-08-03T10:00:00Z'),
      statusContext('Vercel - product', 'SUCCESS', '2026-08-03T10:03:00Z'),
      statusContext('Vercel - web', 'SUCCESS', '2026-08-03T10:03:00Z'),
    ]);
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('rollup が空でも止める', () => {
    const { status, stderr } = runScript([]);
    expect(stderr).toContain('成功した check が 1 件もありません');
    expect(status).toBe(1);
  });

  it('StatusContext の failure も止める', () => {
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      statusContext('Vercel – product', 'FAILURE', '2026-07-30T10:01:00Z'),
    ]);
    expect(stderr).toContain('失敗している check');
    expect(status).toBe(1);
  });
});

describe('affected-aware な Vercel context 要求（Impact Resolver 連携）', () => {
  it('product のみの変更なら Vercel – web が無くても merge へ進む', () => {
    // Vercel skip 導入後の通常状態。unaffected な project の context 欠落は正常。
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-04T10:01:00Z'),
        ...ciChecks(),
      ],
      { files: ['apps/product/src/features/tags/ui/TagList.tsx'] },
    );
    expect(stderr).toContain('必須 Vercel context: Vercel – product');
    expect(stderr).not.toContain('必須 check「Vercel – web」');
    expect(status).toBe(0);
  });

  it('product のみの変更でも Vercel – product の欠落は止める', () => {
    // affected な project の context 欠落は従来どおり fail closed。
    const { status, stderr } = runScript([checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z')], {
      files: ['apps/product/src/features/tags/ui/TagList.tsx'],
    });
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('web のみの変更なら Vercel – product が無くても merge へ進む', () => {
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – web', 'SUCCESS', '2026-08-04T10:01:00Z'),
        ...ciChecks(),
      ],
      { files: ['apps/web/src/app/page.tsx'] },
    );
    expect(stderr).toContain('必須 Vercel context: Vercel – web');
    expect(status).toBe(0);
  });

  it('docs のみの変更なら Vercel context を要求しない', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-04T10:00:00Z'),
        // Static Checks は docs-only でも要求される（#2483 P1 修正後）ため、
        // このテストの主眼（Vercel context の免除）を検証するには別途足す必要がある。
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-04T10:00:00Z'),
      ],
      { files: ['docs/product/specs/calendar.md', 'AGENTS.md'] },
    );
    expect(stderr).toContain('Vercel context は要求しません');
    expect(status).toBe(0);
  });

  it('共通 package の変更は両方の context を要求する', () => {
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-04T10:01:00Z'),
      ],
      { files: ['packages/config/src/env.ts'] },
    );
    expect(stderr).toContain('必須 check「Vercel – web」');
    expect(status).toBe(1);
  });

  it('変更ファイル一覧を取得できなければ両方を必須にする（fail closed）', () => {
    // files API 不通で「影響なし」に倒れると、build 未検証のまま merge できてしまう。
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-04T10:01:00Z'),
      ],
      { filesUnavailable: true },
    );
    expect(stderr).toContain('影響判定を実行できませんでした');
    expect(stderr).toContain('必須 check「Vercel – web」');
    expect(status).toBe(1);
  });

  it('rename では移動元の app の context も必須にする', () => {
    // API は移動先を filename、移動元を previous_filename で返す。移動先だけを見ると
    // apps/product → docs の rename が docs-only 判定になり、ファイルが消えた側の
    // build を検証しないまま merge できてしまう。
    const { status, stderr } = runScript([checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z')], {
      files: ['docs/moved.md'],
      previousFiles: ['apps/product/src/moved.ts'],
    });
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('rename の移動元は件数に数えない（changedFiles と一致させる）', () => {
    // previous_filename を件数に含めると申告件数と食い違い、正常な rename PR が
    // truncation 扱いで止まる（fail closed の過剰発動）。
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-04T10:01:00Z'),
        ...ciChecks(),
      ],
      {
        files: ['apps/product/src/moved.ts'],
        previousFiles: ['apps/product/src/old.ts'],
        changedFilesCount: 1,
      },
    );
    expect(stderr).not.toContain('truncation');
    expect(status).toBe(0);
  });

  it('取得件数が PR の申告件数に足りなければ両方を必須にする（3,000 件上限などの truncation）', () => {
    // files endpoint は --paginate でも 3,000 件で打ち切られ、その状態で成功終了する。
    // 打ち切りを完全な一覧と扱うと、後半にだけ現れる app の context が要求されない。
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – web', 'SUCCESS', '2026-08-04T10:01:00Z'),
      ],
      { files: ['apps/web/src/page.tsx'], changedFilesCount: 3000 },
    );
    expect(stderr).toContain('truncation');
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('一覧が部分的に取れて失敗した場合も両方を必須にする（pagination 途中失敗）', () => {
    // `gh api --paginate` はページごとに stdout へ流すため、後半ページの失敗は
    // 「部分的な一覧 + 非 0 終了」になる。部分出力を「取得成功」と扱うと、
    // 後半ページにだけ含まれる app の context を要求しないまま merge できてしまう。
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – web', 'SUCCESS', '2026-08-04T10:01:00Z'),
      ],
      { files: ['apps/web/src/app/page.tsx'], filesPartialFailure: true },
    );
    expect(stderr).toContain('影響判定を実行できませんでした');
    expect(stderr).toContain('必須 check「Vercel – product」');
    expect(status).toBe(1);
  });

  it('未知の path は両方を必須にする（fail closed）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-04T10:01:00Z'),
      ],
      { files: ['mystery.config.xyz'] },
    );
    expect(stderr).toContain('必須 check「Vercel – web」');
    expect(status).toBe(1);
  });
});

/**
 * Draft CI 廃止（#2415）に伴い、軽量層（Static Checks / Unit Tests）は draft の間
 * skip される。skipped は失敗にも成功にも実行中にも数えないため、集約判定
 * （失敗 0 / 実行中 0 / success 1 件以上）だけでは「一度も実走しないまま merge」
 * を通してしまう（success 1 件は draft guard を持たない docs guard が満たす）。
 * 名前で success を要求してその class を閉じているかを固定する。
 */
describe('軽量層（Static Checks / Unit Tests）の実走要求（#2415）', () => {
  // Vercel context を要求されない docs 以外の path で、CI check の有無だけを見る。
  // `scripts/**` は product / web いずれにも影響しないが docs-only でもない。
  const SCRIPTS_ONLY = { files: ['scripts/ci/impact.mjs'] };

  it('draft 中の skipped が残ったままなら止める（ready 直後の窓で merge しない）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...ciChecks('SKIPPED'),
      ],
      SCRIPTS_ONLY,
    );
    expect(stderr).toContain('必須 check「🔍 Static Checks」');
    expect(status).toBe(1);
  });

  it('check が 1 件も登録されていなければ止める（workflow が発火しなかった場合）', () => {
    const { status, stderr } = runScript(
      [checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z')],
      SCRIPTS_ONLY,
    );
    expect(stderr).toContain('必須 check「🔍 Static Checks」が 1 件も見つかりません');
    expect(status).toBe(1);
  });

  it('Unit Tests だけが欠けていても止める', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-26T10:00:00Z'),
      ],
      SCRIPTS_ONLY,
    );
    expect(stderr).toContain('必須 check「📦 Unit Tests」');
    expect(status).toBe(1);
  });

  it('両方 success なら通す', () => {
    const { status, stderr } = runScript(
      [checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'), ...ciChecks()],
      SCRIPTS_ONLY,
    );
    expect(stderr).not.toContain('必須 check「🔍 Static Checks」');
    expect(stderr).not.toContain('必須 check「📦 Unit Tests」');
    expect(status).toBe(0);
  });

  it('docs-only PR では Unit Tests の skipped だけを許容する（Static Checks は引き続き要求する）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('📦 Unit Tests', 'SKIPPED', '2026-08-26T10:00:00Z'),
      ],
      { files: ['docs/product/specs/calendar.md'] },
    );
    expect(stderr).toContain('docs-only の変更のため');
    expect(status).toBe(0);
  });

  it('docs-only PR でも Static Checks が skipped のままなら止める（#2483 P1: secret scan bypass の再発防止）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...ciChecks('SKIPPED'),
      ],
      { files: ['docs/product/specs/calendar.md'] },
    );
    expect(stderr).toContain('必須 check「🔍 Static Checks」');
    expect(status).toBe(1);
  });

  // 未知の path は docs でも app でもない。docsOnly=false 側（要求する側）へ倒る
  // ことを、Vercel context ではなくこの gate で直接固定する（既存の
  // 「未知の path は両方を必須にする」は Vercel gate で先に止まるため、
  // 軽量層の要求が未知 path で効くことまでは証明していない）。
  it('未知の path でも docs-only 扱いにせず要求する', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        statusContext('Vercel – product', 'SUCCESS', '2026-08-26T10:01:00Z'),
        statusContext('Vercel – web', 'SUCCESS', '2026-08-26T10:01:00Z'),
      ],
      { files: ['mystery.config.xyz'] },
    );
    expect(stderr).toContain('必須 check「🔍 Static Checks」');
    expect(status).toBe(1);
  });

  // 影響判定が不能なとき docsOnly を true 側へ倒すと、判定不能がそのまま免除に
  // なってしまう。Vercel context が fail closed で両方必須になるのと同じ向きに揃える。
  it('影響判定に失敗したら docs-only 扱いにせず要求する（fail closed）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...requiredChecks(),
      ].filter((entry) => (entry.name as string) !== '🔍 Static Checks'),
      { filesUnavailable: true },
    );
    expect(stderr).toContain('影響判定を実行できませんでした');
    expect(stderr).toContain('必須 check「🔍 Static Checks」');
    expect(status).toBe(1);
  });

  // ── Integration Tests（#2539 で test job から分離）─────────────────
  //
  // 分離で「job まるごとが `if:` で skip されうる」形が新しく生まれた。Unit Tests と
  // 同じ class（draft skip / 配線ミスで一度も実走しないまま merge）が再発しないよう
  // 名前で要求するが、**affected でない PR では skip が正常**なので、要求の向きを
  // 両方向とも固定する（無条件に要求すると skip される PR が永久に missing で止まる）。
  //
  // nightly.yml は integration=true かつ product/web=false（Vercel context を
  // 誘発しない）ので、この gate だけを切り出して観察できる。
  const INTEGRATION_AFFECTED = { files: ['.github/workflows/nightly.yml'] };

  it('integration affected な PR で Integration Tests が欠けていれば止める', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...ciChecksWithout('🧪 Integration Tests'),
      ],
      INTEGRATION_AFFECTED,
    );
    expect(stderr).toContain('必須 check「🧪 Integration Tests」が 1 件も見つかりません');
    expect(status).toBe(1);
  });

  it('integration affected な PR で Integration Tests が skipped のままなら止める', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...ciChecksWithout('🧪 Integration Tests'),
        checkRun('🧪 Integration Tests', 'SKIPPED', '2026-08-26T10:00:00Z'),
      ],
      INTEGRATION_AFFECTED,
    );
    expect(stderr).toContain('必須 check「🧪 Integration Tests」');
    expect(status).toBe(1);
  });

  it('integration affected な PR で 3 job 揃えば通す', () => {
    const { status, stderr } = runScript(
      [checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'), ...ciChecks()],
      INTEGRATION_AFFECTED,
    );
    expect(stderr).not.toContain('必須 check「🧪 Integration Tests」');
    expect(status).toBe(0);
  });

  it('DB を触らない PR では Integration Tests の欠落を許容する', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...ciChecksWithout('🧪 Integration Tests'),
      ],
      SCRIPTS_ONLY,
    );
    expect(stderr).toContain('DB を触らない変更のため');
    expect(status).toBe(0);
  });

  // docs-only と integration は独立に見る（[#2552](https://github.com/Dayopt/dayopt/issues/2552)）。
  // impact.mjs は rls-snapshot.md のような「docs だが integration を要求する」path を
  // 明示的に想定していて `docsOnly: true, integration: true` を返す。以前は gate も
  // ci.yml も docs-only を外側の条件に置いていたため、rls-snapshot.md 単独の PR で
  // RLS drift 検査（`rls:snapshot:check`）が一度も走らないまま merge できていた。
  //
  // このテストは「gate と ci.yml が同じ向きに揃っている」ことを固定する。ci.yml の
  // integration job も `integration != 'false'` だけで判定するよう直してあるので、
  // **片方だけ変えるとここが落ちて気づける**（その関係は #2552 を直した後も同じ）。
  it('docs-only でも integration affected なら Integration Tests を要求する（ci.yml と対称、#2552）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-26T10:00:00Z'),
      ],
      // integration=true かつ docsOnly=true になる唯一の実在パターン
      { files: ['docs/engineering/data/db/rls-snapshot.md'] },
    );
    // Unit Tests は docs-only のまま免除する（免除するのは unit だけ）
    expect(stderr).toContain('docs-only の変更のため');
    expect(stderr).toContain('必須 check「🧪 Integration Tests」が 1 件も見つかりません');
    expect(status).toBe(1);
  });

  it('docs-only でも Integration Tests が skipped のままなら止める（#2552）', () => {
    // 「missing」だけでなく「skipped で残っている」経路も塞ぐ。draft 期の skipped
    // check run が ready 後も残るケース（#2415 の元事故）が docs-only 側から
    // 復活しないことを固定する。
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🧪 Integration Tests', 'SKIPPED', '2026-08-26T10:00:00Z'),
      ],
      { files: ['docs/engineering/data/db/rls-snapshot.md'] },
    );
    expect(stderr).toContain('必須 check「🧪 Integration Tests」');
    expect(status).toBe(1);
  });

  // このケースは #2552 の修正**前でも**通る（旧実装は docs-only で Integration を
  // 免除していたため）。証明しているのは「修正後に永久停止しないこと」であって
  // 修正そのものではない。上の 2 本が修正の証明を持つ。
  it('docs-only かつ integration affected な PR は Integration Tests が揃えば通る（永久停止しないことの確認）', () => {
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🔍 Static Checks', 'SUCCESS', '2026-08-26T10:00:00Z'),
        checkRun('🧪 Integration Tests', 'SUCCESS', '2026-08-26T10:00:00Z'),
      ],
      { files: ['docs/engineering/data/db/rls-snapshot.md'] },
    );
    // Unit Tests は無くても通る（docs-only で免除される）
    expect(stderr).toContain('docs-only の変更のため');
    expect(stderr).not.toContain('必須 check「📦 Unit Tests」');
    expect(status).toBe(0);
  });

  it('影響判定に失敗したら Integration Tests も要求する（fail closed）', () => {
    // Static Checks / Unit Tests / Vercel context は揃えて、Integration Tests だけを
    // 欠かせる。判定不能（filesUnavailable）でこの gate が緩まないことを固定する。
    const { status, stderr } = runScript(
      [
        checkRun('🛡️ docs & secrets guard', 'SUCCESS', '2026-08-26T10:00:00Z'),
        ...requiredChecks().filter((entry) => (entry.name as string) !== '🧪 Integration Tests'),
      ],
      { filesUnavailable: true },
    );
    expect(stderr).toContain('影響判定を実行できませんでした');
    expect(stderr).toContain('必須 check「🧪 Integration Tests」');
    expect(status).toBe(1);
  });
});

describe('レビュー thread の必須解決 gate', () => {
  const greenRollup = () => [
    checkRun('CI', 'SUCCESS', '2026-08-04T10:00:00Z'),
    ...requiredChecks(),
  ];

  it('未解決 thread が 1 件でもあれば止め、一覧を表示する', () => {
    const { status, stderr } = runScript(greenRollup(), {
      threads: [
        { isResolved: true, path: 'src/resolved.ts' },
        {
          isResolved: false,
          path: 'scripts/tasks/finish-branch.sh',
          author: 'chatgpt-codex-connector',
        },
      ],
    });
    expect(stderr).toContain('未解決のレビュー thread が 1 件');
    expect(stderr).toContain('scripts/tasks/finish-branch.sh');
    expect(status).toBe(1);
  });

  it('全 thread が resolve 済みなら merge へ進む', () => {
    const { status, stderr } = runScript(greenRollup(), {
      threads: [{ isResolved: true }, { isResolved: true }],
    });
    expect(stderr).toContain('未解決のレビュー thread はありません');
    expect(status).toBe(0);
  });

  it('thread の取得に失敗したら止める（fail closed）', () => {
    // 「未確認のまま通す」を許すと、API 障害のたびに gate が消える。
    const { status, stderr } = runScript(greenRollup(), { threadsUnavailable: true });
    expect(stderr).toContain('レビュー thread の状態を取得できませんでした');
    expect(status).toBe(1);
  });

  it('101 件（2 ページ）を全走査し、全 resolve 済みなら merge へ進む', () => {
    // PR #1820 の実測（thread 101 件・未解決 0 件）を再現する。旧実装は
    // first: 100 の 1 ページ目で hasNextPage=true を見た時点で即停止していた
    // （issue #1831）。2 ページ目まで走査して初めて「未解決 0 件」と判定できる。
    const { status, stderr } = runScript(greenRollup(), {
      threadPages: [{ threads: resolvedThreads(100) }, { threads: resolvedThreads(1) }],
    });
    expect(stderr).toContain('未解決のレビュー thread はありません');
    expect(status).toBe(0);
  });

  it('101 件のうち 2 ページ目に未解決が 1 件あれば止める', () => {
    // 1 ページ目だけ見て判定を打ち切っていないことを、2 ページ目側の未解決で確認する。
    const { status, stderr } = runScript(greenRollup(), {
      threadPages: [
        { threads: resolvedThreads(100) },
        { threads: [{ isResolved: false, path: 'scripts/tasks/finish-branch.sh' }] },
      ],
    });
    expect(stderr).toContain('未解決のレビュー thread が 1 件');
    expect(stderr).toContain('scripts/tasks/finish-branch.sh');
    expect(status).toBe(1);
  });

  it('ページ数が上限（20 ページ）を超えるほど残っていれば止める', () => {
    // 暴走防止の上限は件数（100 件超）ではなくページ数。first:100 × 20 ページ
    // 尽くしてもなお hasNextPage が true な場合だけ「全件確認できない」で止める。
    const { status, stderr } = runScript(greenRollup(), {
      threadPages: Array.from({ length: 20 }, () => ({
        threads: resolvedThreads(1),
        hasNextPage: true,
      })),
    });
    expect(stderr).toContain('20 ページ');
    expect(stderr).toContain('全件を確認できません');
    expect(status).toBe(1);
  });

  it('ちょうど 20 ページ目で hasNextPage: false なら全件確認できたとして進む', () => {
    // 上限ぎりぎり（2,000 件）でも「確認できないから停止」に倒れないことを確認する。
    const { status, stderr } = runScript(greenRollup(), {
      threadPages: Array.from({ length: 20 }, () => ({ threads: resolvedThreads(1) })),
    });
    expect(stderr).toContain('未解決のレビュー thread はありません');
    expect(status).toBe(0);
  });
});

describe('gate は REST 直叩きでも緩まない', () => {
  it('branch が main の最新を含んでいなければ止める', () => {
    // up-to-date gate。マージ対象 SHA を compare に pin した後も判定が生きていること。
    const { status, stderr } = runScript([checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z')], {
      compare: 'behind',
    });
    expect(stderr).toContain('branch が main の最新を含んでいません');
    expect(status).toBe(1);
  });

  it('diverged でも止める', () => {
    // stderr まで assert するのは「どの gate で止まったか」を固定するため。status だけを
    // 見ていると、将来 gate の順序が変わって別の gate（例: #2415 で足した軽量層の
    // 名前指定要求）が先に発火した時、止まってはいるが up-to-date gate を証明しない
    // vacuous な test に静かにすり替わる。
    const { status, stderr } = runScript([checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z')], {
      compare: 'diverged',
    });
    expect(stderr).toContain('branch が main の最新を含んでいません');
    expect(status).toBe(1);
  });

  it('draft PR は止める', () => {
    // `gh pr merge` のクライアント側 draft ガードを REST 直叩きで失わないこと。
    const { status, stderr } = runScript([checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z')], {
      isDraft: true,
    });
    expect(stderr).toContain('draft です');
    expect(status).toBe(1);
  });
});

describe('マージ経路（#1771 症状①）', () => {
  it('gh pr merge ではなく gh api でマージする', () => {
    // `gh pr merge --delete-branch` は「削除対象 branch が current」だと実行元 worktree を
    // main へ切り替える。REST 直叩きならローカル git に触れない。
    const { status, stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      ...requiredChecks(),
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain('gh api -X PUT');
    expect(stderr).not.toContain('gh pr merge 123');
  });

  it('head SHA を指定してマージする（gate 通過後の push を弾く）', () => {
    const { stderr } = runScript([
      checkRun('CI', 'SUCCESS', '2026-07-30T10:00:00Z'),
      ...requiredChecks(),
    ]);
    expect(stderr).toContain(`-f sha=${'0'.repeat(40)}`);
  });
});

describe('main checkout に触らない掃除（#1771）', () => {
  it('Cloudの通常checkoutではディレクトリを保持し、対象branchだけ終了する', () => {
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'feature',
    });
    expect(repo.status, repo.stderr).toBe(0);
    expect(existsSync(repo.mainRoot)).toBe(true);
    expect(repo.branchExists()).toBe(false);
    expect(repo.currentBranch(repo.mainRoot)).toBe('');
    expect(repo.localMainMatchesRemote()).toBe(true);
    expect(repo.remoteBranchExists()).toBe(false);
  });

  it('Cloudの通常checkoutにも未保存差分の保護を適用する', () => {
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'feature',
      dirtyFeature: true,
    });
    expect(repo.status).toBe(1);
    expect(repo.stderr).toContain('未コミット');
    expect(repo.branchExists()).toBe(true);
    expect(readFileSync(join(repo.mainRoot, 'feature.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('通常系（MAIN_ROOT が main）は従来どおり branch -d で削除する', () => {
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'main',
    });

    expect(repo.status).toBe(0);
    expect(repo.branchExists()).toBe(false);
    expect(repo.localMainMatchesRemote()).toBe(true);
    // rescue に落ちず -d で成功していること（通常系の挙動を変えていない）
    expect(repo.stderr).not.toContain('main への到達を確認');
    // step 8 の backstop がリモート branch を消していること
    expect(repo.remoteBranchExists()).toBe(false);
  });

  it('MAIN_ROOT の HEAD が別 branch でも branch を削除でき、HEAD を奪わない', () => {
    // 症状②③。`branch -d` は HEAD 基準でマージ済みを見るため、main へ完全に
    // マージ済みでも not fully merged になる。main 基準の判定で救う。
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'other',
    });

    expect(repo.status).toBe(0);
    expect(repo.branchExists()).toBe(false);
    expect(repo.stderr).toContain('main への到達を確認');
    // 別セッションの作業（other）を奪っていないこと
    expect(repo.currentBranch(repo.mainRoot)).toBe('other');
    expect(repo.localMainMatchesRemote()).toBe(true);
  });

  it('main が別 worktree で checkout 中でも失敗せず、その worktree で fast-forward する', () => {
    // 症状①②。従来は `checkout main` が
    // 「main is already used by worktree」で落ちるか、別セッションの HEAD を奪っていた。
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'other',
      addMainWorktree: true,
    });

    expect(repo.status).toBe(0);
    expect(repo.stderr).toContain('checkout 中です');
    expect(repo.branchExists()).toBe(false);
    expect(repo.localMainMatchesRemote()).toBe(true);
    // main を持つ worktree も MAIN_ROOT も checkout 先が変わっていないこと
    expect(repo.currentBranch(repo.mainWorktree)).toBe('main');
    expect(repo.currentBranch(repo.mainRoot)).toBe('other');
  });

  it('feature worktree の中から実行しても完走する', () => {
    // 症状①の実環境。自分が立っている worktree を削除しても後続が壊れないこと。
    const repo = runScriptOnRepo({
      prState: 'MERGED',
      mergeIntoMain: true,
      mainRootHead: 'other',
      addFeatureWorktree: true,
      runFrom: 'feature-worktree',
    });

    expect(repo.status).toBe(0);
    expect(existsSync(repo.featureWorktree)).toBe(false);
    expect(repo.branchExists()).toBe(false);
  });
});

describe('掃除で緩めてはいけない判定（#1771）', () => {
  it('Cloudでも未マージbranchをdetach・削除しない', () => {
    const repo = runScriptOnRepo({
      prState: 'CLOSED',
      mergeIntoMain: false,
      mainRootHead: 'feature',
    });
    expect(repo.status).toBe(1);
    expect(repo.branchExists()).toBe(true);
    expect(repo.currentBranch(repo.mainRoot)).toBe(BRANCH);
    expect(repo.remoteBranchExists()).toBe(true);
  });

  it('マージに失敗したら掃除へ進まない', () => {
    // REST 直叩きは失敗しても fallback しない。worktree も branch も残ること。
    const repo = runScriptOnRepo({
      prState: 'OPEN',
      mergeFails: true,
      mergeIntoMain: false,
      mainRootHead: 'other',
      addFeatureWorktree: true,
    });

    expect(repo.status).toBe(1);
    expect(repo.stderr).toContain('マージに失敗しました');
    expect(existsSync(repo.featureWorktree)).toBe(true);
    expect(repo.branchExists()).toBe(true);
  });

  it('main に到達していない branch は rescue せず停止する', () => {
    // main 基準の判定を入れたことで「未マージでも -D で消える」方向へ倒れていないこと。
    // HEAD が別 branch = -d の偽陰性が起きる条件そのもので確認する。
    const repo = runScriptOnRepo({
      prState: 'CLOSED',
      mergeIntoMain: false,
      mainRootHead: 'other',
    });

    expect(repo.status).toBe(1);
    expect(repo.stderr).toContain('main に到達しておらず');
    expect(repo.branchExists()).toBe(true);
  });
});
