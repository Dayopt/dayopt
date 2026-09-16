/**
 * System Surface + 関係の Markdown 生成。
 *
 * 読み手（人間 / AI）が「外部と何が繋がっているか」「誰が何を呼んでいるか」を
 * 1 file で辿れるようにする。事実の正本はすべてコード側で、ここは view。
 */

import type { CallGraph } from './call-graph.ts';
import type { InventoryItem } from './inventory.ts';
import type { Relations } from './relations.ts';
import type { SystemSurface } from './surface.ts';

function code(text: string): string {
  return `\`${text}\``;
}

function joinCode(values: readonly string[], empty = '—'): string {
  return values.length === 0 ? empty : values.map(code).join(', ');
}

function table(header: readonly string[], rows: readonly string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function section(title: string, body: string[]): string[] {
  return [title, '', ...body, ''];
}

export function renderSurfaceDocument(
  surface: SystemSurface,
  relations: Relations,
  items: InventoryItem[],
  callGraph: CallGraph,
  header: string,
): string {
  const out: string[] = ['# System Surface（自動生成）', '', header, ''];
  out.push(
    '実装から自動発見した「外部との接点・権限・設定」と、実装どうしの関係。概念との対応は',
    '[`architecture-inventory.md`](./architecture-inventory.md) を見る。',
    '',
  );

  // ── 外部との接点 ────────────────────────────────
  out.push('## 外部との接点', '');

  out.push(
    ...section(`### HTTP route（${surface.httpRoutes.length}）`, [
      'tRPC の `/api/trpc` を含む、Next.js の route handler 全件。method は export から取る。',
      '',
      ...table(
        ['app', 'path', 'method', 'runtime', 'maxDuration', 'file'],
        surface.httpRoutes.map((route) => [
          route.app,
          code(route.id),
          route.methods.length > 0 ? route.methods.join(', ') : '—',
          route.runtime ?? '—',
          route.maxDuration ?? '—',
          code(route.path),
        ]),
      ),
    ]),
  );

  const authoritative = surface.schedules.filter((job) => job.authoritative);
  const pgCron = surface.schedules.filter((job) => !job.authoritative);
  out.push(
    ...section(`### 定期実行（${surface.schedules.length}）`, [
      ...table(
        ['source', '対象', 'schedule', '発見元'],
        authoritative.map((job) => [
          job.source,
          code(job.target),
          code(job.schedule),
          code(job.path),
        ]),
      ),
      '',
      `**pg_cron（${pgCron.length}）**: 下表は migration 上の定義を schedule / unschedule の順に畳んだもの。`,
      'production の pg_cron は Supabase Dashboard 側が正本なので、ここは参考値として読む。',
      'job 名を変数で渡す schedule と、jobid で消す unschedule は追えない（実在確認は `cron.job` を引く）。',
      '',
      ...table(
        ['job', 'schedule', '最後に定義した migration'],
        pgCron.map((job) => [code(job.id), code(job.schedule), code(job.path)]),
      ),
    ]),
  );

  out.push(
    ...section(
      '### Supabase（Edge Function / auth hook / storage bucket）',
      table(
        ['種別', '名前', '補足'],
        surface.supabase.map((feature) => [feature.kind, code(feature.id), feature.detail ?? '—']),
      ),
    ),
  );

  // ── 権限と上限 ────────────────────────────────
  out.push('## 権限と上限', '');

  out.push(
    ...section(
      `### OAuth scope（${surface.scopes.length}）`,
      table(
        ['scope', 'MCP tool', 'tRPC procedure'],
        surface.scopes.map((scope) => [
          code(scope.scope),
          joinCode(scope.mcpTools),
          joinCode(scope.trpcPaths),
        ]),
      ),
    ),
  );

  const builderCounts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== 'trpc-procedure' || item.detail === undefined) continue;
    builderCounts.set(item.detail, (builderCounts.get(item.detail) ?? 0) + 1);
  }
  out.push(
    ...section(
      '### procedure builder',
      table(
        ['builder', '使っている procedure 数', '定義'],
        surface.procedureBuilders.map((builder) => [
          code(builder.id),
          String(builderCounts.get(builder.id) ?? 0),
          code(builder.path),
        ]),
      ),
    ),
  );

  out.push(
    ...section(
      `### rate limit（${surface.rateLimits.length}）`,
      table(
        ['limiter', '上限', '窓', '利用箇所'],
        surface.rateLimits.map((limit) => [
          code(limit.id),
          String(limit.limit),
          code(limit.window),
          limit.usedIn.length > 0 ? joinCode(limit.usedIn.slice(0, 3)) : '利用箇所なし',
        ]),
      ),
    ),
  );

  // ── エラーコード ────────────────────────────────
  out.push(
    ...section(`## DB エラーコード（${surface.errorCodes.length}）`, [
      'migration の `RAISE EXCEPTION ... USING ERRCODE` と、app 側でその文字列を参照する file。',
      'message は migration 履歴の重複排除なので、撤去した旧規則の文言が混ざる（現在の規則は',
      '[`invariants.md`](../invariants.md) §時刻 を見る）。',
      '',
      ...table(
        ['code', 'message', 'raise する migration', 'app 側の参照'],
        surface.errorCodes.map((entry) => [
          code(entry.code),
          entry.messages.length > 0 ? entry.messages.slice(0, 3).join(' / ') : '—',
          String(entry.raisedIn),
          entry.referencedIn.length > 0 ? joinCode(entry.referencedIn.slice(0, 3)) : '—',
        ]),
      ),
    ]),
  );

  // ── 分析イベント ────────────────────────────────
  out.push(
    ...section(`## 分析イベント（${surface.analyticsEvents.length}）`, [
      'TS の `PRODUCT_EVENT_NAMES` と DB の CHECK 制約の両方で定義される。両者の不一致は',
      '`pnpm architecture:check` が止める。',
      '',
      ...table(
        ['event', 'DB の CHECK 制約'],
        surface.analyticsEvents.map((event) => [
          code(event.id),
          event.allowedInDb ? '許可' : '**未許可**',
        ]),
      ),
    ]),
  );

  // ── 設定 ────────────────────────────────
  out.push('## 設定', '');
  out.push(
    ...section(`### env 変数（${surface.envVars.length}）`, [
      '名前と所在だけを載せる（値は 1Password にあり、この生成物は触らない）。',
      '',
      ...table(
        [
          'env',
          '必須',
          'visibility',
          'environment',
          '1Password item',
          'apps/product の env schema',
        ],
        surface.envVars.map((env) => [
          code(env.id),
          env.required ? 'yes' : 'no',
          env.visibility,
          env.environments.join(', '),
          env.items.join(', '),
          env.inProductEnvSchema ? 'あり' : '—',
        ]),
      ),
    ]),
  );

  out.push(
    ...section(
      `### workspace package（${surface.packages.length}）`,
      table(
        ['package', 'exports', '依存している workspace'],
        surface.packages.map((pkg) => [
          code(pkg.id),
          joinCode(pkg.exports),
          joinCode(pkg.dependents),
        ]),
      ),
    ),
  );

  // ── 関係 ────────────────────────────────
  out.push('## 関係', '');

  out.push(
    ...section('### MCP tool → tRPC procedure', [
      '1 file が複数 tool を登録することがあるため、file 単位で出す（tool ごとの内訳は',
      '型チェッカーを使う次の段で分ける）。ここに出ない tool は tRPC を経由せず DB 関数を直接呼ぶ。',
      '',
      ...table(
        ['tool', 'procedure', 'file'],
        relations.mcpToolProcedures.map((entry) => [
          joinCode(entry.tools),
          joinCode(entry.procedures, 'tRPC を経由しない'),
          code(entry.path),
        ]),
      ),
    ]),
  );

  const usageRows = relations.procedureUsage.map((procedure) => [
    code(procedure.id),
    String(procedure.callers.app.length),
    String(procedure.callers.mcp.length),
  ]);
  out.push(
    ...section(`### tRPC procedure の呼び出し元（${relations.procedureUsage.length}）`, [
      '呼び出し元は file 数。`api.x.y.useQuery` / `utils.x.y.invalidate` / `helpers.x.y.prefetch` /',
      '`trpc.x.y(`（MCP bridge）を数える。test と Story は数えない。',
      '',
      ...table(['procedure', 'app からの参照 file', 'MCP からの参照 file'], usageRows),
    ]),
  );

  out.push(
    ...section(`### どこからも呼ばれていない procedure（${relations.unusedProcedures.length}）`, [
      '削除候補ではあるが、判断は別（外部契約に近いものがある）。ここは事実の提示だけ。',
      '',
      relations.unusedProcedures.length === 0
        ? 'なし。'
        : relations.unusedProcedures.map((id) => `- ${code(id)}`).join('\n'),
    ]),
  );

  out.push(
    ...section(
      '### store の利用元',
      table(
        ['store', '利用 file 数', '利用 file（先頭 3 件）'],
        relations.storeUsage.map((store) => [
          code(store.id),
          String(store.consumers.length),
          joinCode(store.consumers.slice(0, 3)),
        ]),
      ),
    ),
  );

  const featuresWithDoc = new Set(relations.docCodeLinks.flatMap((link) => link.features));
  const allFeatures = items.filter((item) => item.kind === 'feature').map((item) => item.id);
  out.push(
    ...section('### docs → feature', [
      'docs の frontmatter `code:` が指す実装から引く。',
      '',
      ...table(
        ['doc', 'feature'],
        relations.docCodeLinks
          .filter((link) => link.features.length > 0)
          .map((link) => [code(link.doc), joinCode(link.features)]),
      ),
      '',
      `**doc から辿れない feature**: ${joinCode(
        allFeatures.filter((feature) => !featuresWithDoc.has(feature)),
        'なし',
      )}`,
    ]),
  );

  const routeSpecs = new Map<string, string[]>();
  for (const link of relations.e2eRoutes) {
    for (const route of link.routes) {
      routeSpecs.set(route, [...(routeSpecs.get(route) ?? []), link.spec]);
    }
  }
  const unmatched = [...new Set(relations.e2eRoutes.flatMap((link) => link.unmatched))].sort();
  out.push(
    ...section('### E2E spec → route', [
      ...table(
        ['route', 'spec 数', 'spec'],
        items
          .filter((item) => item.kind === 'route')
          .map((route) => {
            const specs = routeSpecs.get(route.id) ?? [];
            return [
              code(route.id),
              String(specs.length),
              joinCode(
                specs.map((spec) => spec.replace(`${'apps/product/src/lib/test/e2e'}/`, '')),
                'E2E なし',
              ),
            ];
          }),
      ),
      '',
      `**route に一致しなかった URL**: ${joinCode(unmatched, 'なし')}（legacy redirect の入口など）`,
    ]),
  );

  const dbTests = new Map(relations.dbFunctionTests.map((entry) => [entry.id, entry.tests]));
  const appCalledFunctions = items.filter(
    (item) => item.kind === 'db-function' && (item.usedBy ?? []).length > 0,
  );
  const untested = appCalledFunctions.filter((fn) => (dbTests.get(fn.id) ?? []).length === 0);
  out.push(
    ...section('### DB 関数の integration test 被覆', [
      `app から呼ぶ DB 関数 ${appCalledFunctions.length} 件のうち、integration test（TS / SQL）から`,
      `呼ばれているのは ${appCalledFunctions.length - untested.length} 件。`,
      '',
      `**test から呼ばれていない（${untested.length}）**: ${joinCode(
        untested.map((fn) => fn.id),
        'なし',
      )}`,
    ]),
  );

  out.push(
    ...section(`### tRPC procedure → DB（${callGraph.procedures.length}）`, [
      '型チェッカーで `procedure → service → .from() / .rpc()` を辿った結果。DI（`this.x.method`）や',
      '条件分岐で決まるテーブル名も解決する。ここに出ない procedure は DB を触らない。',
      '',
      ...table(
        ['procedure', 'テーブル', 'DB 関数'],
        callGraph.procedures.map((procedure) => [
          code(procedure.id),
          joinCode(procedure.tables),
          joinCode(procedure.functions),
        ]),
      ),
    ]),
  );

  out.push(
    ...section(`### MCP tool → DB（${callGraph.mcpTools.length}）`, [
      'tRPC を経由しない書き込み tool は、receipt を残す `apply_mcp_*` 関数を必ず通る（`pnpm architecture:check` が検査する）。',
      '',
      ...table(
        ['tool', 'テーブル', 'DB 関数'],
        callGraph.mcpTools.map((tool) => [
          code(tool.tool),
          joinCode(tool.tables),
          joinCode(tool.functions),
        ]),
      ),
    ]),
  );

  out.push(
    ...section('### 画面 → 使う procedure', [
      'page から import を宣言元まで解決して辿った結果（barrel の再 export で無関係な feature を',
      '引き込まない）。prefetch と client hook の両方を含む。',
      '',
      ...table(
        ['route', '数', 'procedure'],
        callGraph.pages.map((page) => [
          code(page.route),
          String(page.procedures.length),
          joinCode(page.procedures),
        ]),
      ),
    ]),
  );

  out.push(
    ...section(
      '### feature ごとの test / Story 被覆',
      table(
        ['feature', 'source', 'test file', 'component', 'Story のある component'],
        relations.featureCoverage.map((coverage) => [
          code(coverage.feature),
          String(coverage.sourceFiles),
          String(coverage.testFiles),
          String(coverage.components),
          `${coverage.componentsWithStory} / ${coverage.components}`,
        ]),
      ),
    ),
  );

  return out.join('\n');
}
