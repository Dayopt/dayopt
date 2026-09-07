import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IMPACT_WIRING, WORST_CASE_RELEASE_MS } from './production-release.mjs';
import { IMPACT_OUTPUT_KEYS } from './release-impact.mjs';

/**
 * Production Release workflow は Vercel の promote / rollback 権限を持つ token を
 * 扱うため、信頼境界を YAML の形で固定する。bash step は unit test できないので、
 * 壊れたら Production に影響する制御だけを contract として検査する。
 */
const WORKFLOWS = join(process.cwd(), '.github/workflows');

function workflow(name: string) {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

describe('release workflow contract', () => {
  const release = workflow('promote.yml');

  const onBlock = release.slice(release.indexOf('\non:'), release.indexOf('\npermissions:'));
  /** release job の宣言だけを切り出す（層 3 job の設定と取り違えないため）。 */
  const releaseJob = release.slice(release.indexOf('\n  release:'));

  /**
   * 行頭コメントを落とす。この contract は「YAML が何を宣言しているか」を見るもので、
   * 同じ文字列が説明文に現れただけで判定が動くと、コメントを書き足せない test になる。
   */
  const code = (yaml: string) =>
    yaml
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  /** release job の **job レベル** `if:`（step の `if: always()` と混ざらないよう分ける）。 */
  const releaseJobIf = releaseJob.slice(
    releaseJob.indexOf('\n    if:'),
    releaseJob.indexOf('\n    runs-on:'),
  );

  it('promotes on every push to main, with no paths filter (2026-09-03)', () => {
    // #2268 は「merge のたびに Production が切り替わる」ことを嫌って push:main を
    // 廃止したが、その代償として promote が人の手番になり実際に 6 日 40 merge 分
    // 滞留した。2026-09-03 に merge 連動へ戻し、切り替えの安全は「影響のある層 3
    // が同一 run で green」であることで担保する（層 4 gate は release job の if:）。
    expect(onBlock).toMatch(/^\s*push:/m);
    expect(onBlock).toMatch(/^\s*branches:\s*\[main\]\s*$/m);
    expect(onBlock).toMatch(/^\s*workflow_dispatch:/m);

    // **paths filter を付けない。** docs のみの merge も release job まで到達させ、
    // `unaffected` の success status を発行する必要がある（create-release.yml の
    // tag gate がこの status を要求するため、付けると tag が打てなくなる）。
    expect(onBlock).not.toMatch(/^\s*paths(-ignore)?:/m);
  });

  it('has no sha input; the release target is always the run commit', () => {
    // 層 3 を同一 run で走らせる設計では、checkout と異なる SHA は検証不能。
    // production-release.mjs も checkoutAtTarget=false を全 project affected へ
    // 倒すため、sha input を残すと「未検証 × 全 project promote」しか作れない。
    expect(release).not.toContain('inputs.sha');
    expect(release).toContain('sha="$GITHUB_SHA"');
  });

  /**
   * `- uses: actions/checkout` から次の step（同インデントの `- `）までを切り出す。
   * job が 1 つだった頃は indexOf で足りたが、impact / layer 3 / release の 4 job
   * 構成では最初の 1 件しか見ない検査が残りを素通りさせる。
   */
  const checkoutBlocks = (yaml: string) =>
    [...yaml.matchAll(/^(\s*)- uses: actions\/checkout@[^\n]*\n/gm)].map((match) => {
      const start = match.index ?? 0;
      const rest = yaml.slice(start + match[0].length);
      const nextStep = rest.search(new RegExp(`^${match[1]}- `, 'm'));
      return match[0] + (nextStep === -1 ? rest : rest.slice(0, nextStep));
    });

  it('never checks out a caller-supplied ref (every job)', () => {
    // ref に呼び出し側の入力を渡すと、未 merge の commit が持つ script が
    // Production secret 付きで実行される。これが唯一の実効的な防御。
    const blocks = checkoutBlocks(release);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(block).toContain('persist-credentials: false');
      expect(block).not.toMatch(/^\s*ref:/m);
    }
  });

  it('validates the SHA shape before using it in an API path', () => {
    const shapeCheck = release.indexOf('40 character commit SHA');
    const compareCall = release.indexOf('compare/heads/main');
    expect(shapeCheck).toBeGreaterThan(-1);
    expect(compareCall).toBeGreaterThan(shapeCheck);
  });

  it('accepts only commits already merged into main', () => {
    expect(release).toContain('compare/heads/main...$sha');
    expect(release).toContain('"$status" != "identical" ] && [ "$status" != "behind"');
    // ahead / diverged を許可に足すと未 merge の commit が Production へ出る。
    expect(release).not.toMatch(/status" = "(ahead|diverged)"/);
  });

  it('keeps the compare check fail-closed', () => {
    // export / local を前置すると command substitution の終了ステータスが
    // 代入文に伝わらず、gh の失敗が握り潰される。
    expect(release).not.toMatch(/^\s*(export|local|declare)\s+status=\$\(/m);
  });

  it('publishes the commit status only for a resolved SHA', () => {
    expect(release).toContain("if: always() && steps.target.outputs.sha != ''");
    expect(release).toContain('statuses/$RELEASE_SHA');
    // caller の入力を status API のパスへ直接入れない。
    expect(release).not.toContain('statuses/${{ inputs.sha }}');
  });

  it('checks out enough history to diff against the live production SHA', () => {
    // shallow clone だと過去の production SHA が checkout に無く、影響判定が毎回
    // fail closed へ落ちる。**impact job と release job の両方**が live SHA から
    // の diff を取るため、両方に要る（impact 側が shallow だと層 3 が毎 merge で
    // フル実行になり、この設計のコスト前提が崩れる）。
    const deep = checkoutBlocks(release).filter((block) => /^\s*fetch-depth:\s*0\s*$/m.test(block));
    expect(deep.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a no-op release as success', () => {
    // app へ影響しない merge（docs / CI 設定）は promote が 0 件でも live 相当。
    // ここで failure にすると、その commit へ永久に tag を打てなくなる。
    const publishStep = release.slice(release.indexOf('Publish Production Release status'));
    expect(publishStep).toMatch(/RELEASE_STATUS" = "unaffected"[\s\S]{0,200}state=success/);
    // 合否側でも unaffected を落とさない（superseded だけが失敗）。
    const enforceStep = release.slice(release.indexOf('Enforce release result'));
    expect(enforceStep).not.toContain('unaffected');
    expect(enforceStep).toContain('"$RELEASE_STATUS" = "superseded"');
  });

  it('keeps the release manifest even when the run fails', () => {
    // project ごとに live SHA が分かれうるため、部分失敗の復旧では manifest が
    // 手動 rollback 先の一次情報になる。失敗時に落とすと復旧の手掛かりが消える。
    expect(release).toContain('RELEASE_MANIFEST_PATH: release-manifest.json');
    const uploadStep = release.slice(release.indexOf('Upload release manifest'));
    expect(uploadStep).toMatch(/if:\s*always\(\)/);
    expect(uploadStep).toContain('path: release-manifest.json');
  });

  it('scopes the release manifest artifact name by run attempt', () => {
    // 同名 artifact は同一 run 内で 2 度 upload できない。re-run（workflow の
    // 再試行）すると 1 回目の attempt が既に同名を使っているため upload が失敗し、
    // 手動 rollback の一次情報である manifest が re-run 側では 1 つも残らない。
    const uploadStep = release.slice(release.indexOf('Upload release manifest'));
    expect(uploadStep).toContain('name: release-manifest-${{ github.run_attempt }}');
    expect(uploadStep).not.toMatch(/^\s*name:\s*release-manifest\s*$/m);
  });

  it('refuses to call a superseded commit live', () => {
    // superseded は promote 0 件。success を publish すると create-release.yml の
    // gate を素通りし、live でない commit に Release が作られる。
    expect(release).toContain('steps.release.outputs.release_status');
    const publishStep = release.slice(release.indexOf('Publish Production Release status'));
    expect(publishStep).toMatch(/RELEASE_STATUS" = "superseded"[\s\S]{0,200}state=failure/);
  });

  it('gates promote on in-run layer 3 results, not check-run names', () => {
    // 旧実装は nightly.yml の job 表示名を literal で照合していた。改名すると
    // promote が fail closed で止まる結合を持ち、層 3 がいつ・どの SHA で走ったかは
    // promote 側から制御できなかった。層 3 を同一 workflow へ移し、needs の
    // result で判定することで、その結合ごと消えている。
    const gate = releaseJob;

    // 層 3 の 2 job がこの workflow の job として実在する。
    expect(release).toMatch(/^\s*name: "\\U0001F3AD E2E Tests"\s*$/m);
    expect(release).toMatch(/^\s*name: "\\U0001F310 Web Build & E2E"\s*$/m);
    expect(release).toMatch(/^\s*needs: \[impact, e2e, web\]\s*$/m);

    // check-run 名の照合はもう存在しない。
    expect(release).not.toContain('check-runs');
    expect(release).not.toContain('required_checks');
    expect(gate.length).toBeGreaterThan(0);
  });

  it('pins the release gate expression exactly', () => {
    // **部分文字列の検査では守れない。** 必要な conjunct の存在だけを見る形だと、
    // 既存 literal を残したまま外側に選言を 1 本足すだけで gate 全体を無効化できる
    // （内製クロスレビューで実測: `( needs.impact.result == 'success' || ...既存... )`
    // を足した workflow が全 assert を通過した）。promote.yml は保護対象 path で、
    // この test がその guardrail なので、式は全文で固定する。
    //
    // 意図して式を変える時はこの期待値も同時に更新する。その差分がレビューで
    // 「gate の意味が変わった」と読める形になることがこの assert の目的。
    const normalized = releaseJobIf.replace(/\s+/g, ' ').trim();

    expect(normalized).toBe(
      'if: >- ${{ !cancelled() ' +
        "&& ( github.event.inputs.force == 'true' " +
        "|| ( needs.impact.result == 'success' " +
        "&& (needs.impact.outputs.product_affected == 'false' || needs.e2e.result == 'success') " +
        "&& (needs.impact.outputs.web_affected == 'false' || needs.web.result == 'success') ) ) }}",
    );
  });

  it('exempts a layer 3 suite only on an explicit false, never on a missing output', () => {
    // `!= 'true'` 形だと空文字が免除側に落ちる。impact job の outputs キー / step の
    // id / impactKey のいずれかを改名すると `needs.impact.outputs.*` が空文字になり、
    // 層 3 も skip されたうえで gate が素通りする（= 層 3 ゼロで promote）。
    expect(releaseJobIf).toContain("product_affected == 'false'");
    expect(releaseJobIf).toContain("web_affected == 'false'");
    expect(releaseJobIf).not.toContain("!= 'true'");
  });

  it('wires the impact outputs the gate reads to the keys the script emits', () => {
    // 上の空文字 fail-open を実際に起こすのは「片方だけ改名」なので、script の出力
    // キー・job の outputs マッピング・gate の参照の 3 点が一致することを固定する。
    const impactJob = release.slice(release.indexOf('\n  impact:'), release.indexOf('\n  e2e:'));
    const stepId = impactJob.match(/^\s*id: (\S+)\s*$/m)?.[1];
    expect(stepId).toBeTruthy();

    for (const key of IMPACT_OUTPUT_KEYS) {
      // job の outputs は script が書く key を、その step の outputs から読む。
      expect(impactJob).toContain(`${key}: \${{ steps.${stepId}.outputs.${key} }}`);
      // gate はその job outputs を参照する。
      expect(releaseJobIf).toContain(`needs.impact.outputs.${key}`);
    }

    // 逆向き: gate が参照する outputs が IMPACT_OUTPUT_KEYS 以外を含まない。
    const referenced = [...releaseJobIf.matchAll(/needs\.impact\.outputs\.(\w+)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(referenced)].sort()).toEqual([...IMPACT_OUTPUT_KEYS].sort());
  });

  it('passes the impact verdict into the release script, not just into the gate', () => {
    // gate（release job の `if:`）は T0（impact job 実行時点）の判定しか見ない。
    // live が Instant Rollback で後退すると release 側（T1）だけが affected になり、
    // 層 3 未実行の project を promote しうる（#2574）。script が T0 の verdict を
    // 読めるよう、同じ値を step env でも渡す。
    // **両端を個別に確認する。** どちらかの step 名が変わると indexOf が -1 を返し、
    // slice(start, -1) は「job の末尾まで」へ黙って広がる。そうなると配線を別 step へ
    // 移しても全 assert が通ってしまう（`not.toBe('')` では捕まらない）。
    const stepStart = releaseJob.indexOf('Wait, smoke, and promote Production');
    const stepEnd = releaseJob.indexOf('Publish Production Release status');
    expect(stepStart).toBeGreaterThan(-1);
    expect(stepEnd).toBeGreaterThan(stepStart);
    const releaseStep = releaseJob.slice(stepStart, stepEnd);

    // 出力キーと env 名の対応は `IMPACT_WIRING` の 1 エントリから導出する。
    // 2 配列を index で突き合わせていた頃は、片方だけ並べ替えられると test が
    // **入れ替わった配線を要求する側へ回り**、runtime では別 project の verdict を
    // 静かに使う（層 3 未実行の promote が通る）形になっていた。
    for (const { outputKey, envVar } of IMPACT_WIRING) {
      expect(releaseStep).toContain(`${envVar}: \${{ needs.impact.outputs.${outputKey} }}`);
    }

    // 逆向き: script が読む env が余分な値を混ぜていない。
    const wired = [...releaseStep.matchAll(/^\s*(RELEASE_IMPACT_[A-Z_]+):/gm)].map(
      (match) => match[1],
    );
    expect([...new Set(wired)].sort()).toEqual(IMPACT_WIRING.map((w) => w.envVar).sort());

    // **既定値で丸めない。** `|| 'true'` のような fallback を書くと、配線が落ちた時に
    // 層 3 ゼロで promote が通り、この対策そのものが無効になる。
    expect(releaseStep).not.toMatch(/RELEASE_IMPACT_[A-Z_]+:\s*\$\{\{[^}]*(\|\||&&)[^}]*\}\}/);
  });

  it('keeps the layer 3 gate fail-closed for cancelled jobs', () => {
    // job レベル concurrency で層 3 が cancel されると result は 'cancelled' に
    // なるが、式関数の cancelled() は **run 全体**の cancel しか見ないため false の
    // まま。`success() || failure()` 系の書き方だと release が走ってしまう。
    // needs.<id>.result を直接見ることでこの穴を塞ぐ。
    expect(releaseJobIf).toContain('!cancelled()');
    // always() は使わない（run 全体が cancel された時にまで promote しない）。
    // step レベルの `if: always()`（status publish / manifest）はこの対象外。
    expect(releaseJobIf).not.toContain('always()');
    // impact が落ちた run では層 3 の要否そのものが不明なので promote しない。
    expect(releaseJobIf).toContain("needs.impact.result == 'success'");
  });

  it('never references a needs id containing a hyphen', () => {
    // GitHub の式では `needs.web-e2e` が減算として解析され、gate が黙って壊れる。
    expect(code(release)).not.toMatch(/needs\.[A-Za-z0-9_]*-/);
  });

  it('lets force skip layer 3 only through workflow_dispatch', () => {
    // push イベントに inputs は無いので `github.event.inputs.force` は空になり、
    // 自動経路から force へ入る道は存在しない。
    expect(release).toContain("github.event.inputs.force == 'true'");
    expect(release).toMatch(/if:.*needs\.impact\.outputs\.product_affected == 'true'/);
    expect(release).toContain("github.event.inputs.force != 'true'");
  });

  it('serializes promote at the job level, never the workflow level', () => {
    // workflow レベルで直列化すると、GitHub は group ごとに pending を 1 本しか
    // 保持せず新着で古い pending を cancel する。層 3 を内包した状態でそれをやると
    // burst（1 時間に 1〜3 merge）の 2 本目が promote されないまま消える。
    const beforeJobs = code(release.slice(0, release.indexOf('\njobs:')));
    expect(beforeJobs).not.toMatch(/^concurrency:/m);
    expect(releaseJob).toMatch(/group: production-release\s*$/m);
    expect(releaseJob).toMatch(/cancel-in-progress: false/);
  });

  it('gives each layer 3 job its own concurrency group', () => {
    // **2 job を同じ group に入れてはいけない。** job レベル group は同一 run 内の
    // job 同士にも効くため、cancel-in-progress: true だと e2e と web が互いを
    // キャンセルする。ref ごとに suite 別 group を持てば、新しい push が古い run の
    // 同種 job だけをキャンセルする挙動になる。
    expect(release).toContain('group: promote-layer3-e2e-${{ github.ref }}');
    expect(release).toContain('group: promote-layer3-web-${{ github.ref }}');
  });

  it('keeps status write permission on the release job only', () => {
    // workflow レベルで配ると、層 3 job（PR/main の code を実行する）まで commit
    // status を書ける token を持つ。
    const beforeJobs = code(release.slice(0, release.indexOf('\njobs:')));
    expect(beforeJobs).not.toContain('statuses: write');
    expect(code(releaseJob)).toContain('statuses: write');
  });

  it('allows more wall clock than the script can consume', () => {
    // job が先に kill されると、rollback 途中の片系 promote が
    // 手動 rollback の手掛かり（run summary の previous id）ごと消える。
    // 層 3 job の timeout-minutes: 20 を拾わないよう release job から取る。
    const timeoutMinutes = Number(releaseJob.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    expect(timeoutMinutes).toBeGreaterThan(0);
    expect(timeoutMinutes * 60_000).toBeGreaterThan(WORST_CASE_RELEASE_MS);
    // checkout / setup / API 往復のぶんの余裕も残す。
    expect(timeoutMinutes * 60_000 - WORST_CASE_RELEASE_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('attaches the job to an environment that can gate non-main dispatches', () => {
    expect(release).toMatch(/^\s*environment:\s*production-release\s*$/m);
  });

  it('gates GitHub Release creation on a live Production Release status', () => {
    const createRelease = workflow('create-release.yml');
    expect(createRelease).toContain('Production Release');
    expect(createRelease).toContain('"$state" != "success"');
  });

  it('reports a promote failure through a job that outlives the skipped release', () => {
    // 層 3 が赤いと release job ごと skip されるため、release の step では失敗を
    // 拾えない。independent な job が needs の result を直接見る（#2643）。
    const notify = release.slice(
      release.indexOf('\n  notify_failure:'),
      release.indexOf('\n  release:'),
    );
    expect(notify).not.toBe('');
    expect(notify).toMatch(/^\s*needs: \[impact, e2e, web, release\]\s*$/m);
    for (const job of ['impact', 'e2e', 'web', 'release']) {
      expect(notify).toContain(`needs.${job}.result == 'failure'`);
    }
    // 暗黙の success() が付くと、needs が失敗した時点でこの job も skip される。
    expect(notify).toContain('!cancelled()');
    expect(notify).toContain('gh issue create');
    // 失敗のたびに新規 issue を作らない（既存 open があれば追記する）。
    expect(notify).toContain('gh issue comment');
  });

  it('keeps issue write permission off every job that runs repository code', () => {
    // 起票 job は checkout しない。code を実行する job に書き込み token を置かない
    // （層 3 は PR / main の code をそのまま走らせる）。
    const beforeJobs = code(release.slice(0, release.indexOf('\njobs:')));
    expect(beforeJobs).not.toContain('issues: write');

    const notify = release.slice(
      release.indexOf('\n  notify_failure:'),
      release.indexOf('\n  release:'),
    );
    expect(code(notify)).toContain('issues: write');
    expect(notify).not.toContain('actions/checkout');

    // 他の job は起票権限を持たない。
    const jobsBlock = release.slice(release.indexOf('\njobs:'));
    const grantCount = code(jobsBlock).match(/issues: write/g)?.length ?? 0;
    expect(grantCount).toBe(1);
  });

  it('keeps the audit workflow pinned to its trusted base revision', () => {
    // promote.yml と対称に「掃除」されないよう固定する。pull_request_target で
    // PR head を checkout すると、PR code が Vercel token を読める。
    const audit = workflow('production-config-audit.yml');
    expect(audit).toContain('ref: ${{ github.event.pull_request.base.sha || github.sha }}');
  });
});
