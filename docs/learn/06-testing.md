---
status: current
last_verified: 2026-09-21
---

# 6. テスト（何がどの経路を守っているか）

## この章で答えられるようになる問い

- ある変更を入れる時、どの層のテストで守るべきか
- 経路のどの段が、どのテストで守られているか。守られていない段はどこか
- テストが緑でも、変更後の挙動を証明していないのはどんな時か

## 概念

テストは層ごとに証明するものが違う。小さい問題は小さい層で守り、E2E は中核の流れに絞る。

| 層                            | 証明すること                                 | 回る場所                                       |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Static（型・lint・境界）      | コードとして成立している                     | pre-push、PR                                   |
| Unit（Vitest）                | 小さなロジックが正しい                       | PR（関係するものだけ）、nightly で全部         |
| Storybook + Vitest            | UI 部品の状態・操作・a11y                    | main へ入った後（promote）                     |
| Integration（local Supabase） | 部品・DB・API をつないでも正しい（RLS・RPC） | DB を触る PR                                   |
| E2E（Playwright）             | 利用者が中核の目的を端から端まで達成できる   | main へ入った後（promote）。赤なら本番へ出ない |

**回帰テストの 4 手順**: 失敗を再現する → 原因に最も近い**最小の層**を選ぶ → 直す前に赤、直した後に緑を確かめる → 中核の流れを壊す種類の不具合だけ上の層にも足す。PR には「どの層に赤を入れたか」を書く。

**挙動を証明しないテスト（TEST-1）**: 操作の前から存在する要素を探しているだけ、どれにでも当たる assert、呼ばれていない mock — これらは変更の前後どちらでも緑になる。

## Dayopt ではどうなっているか

下の一覧は経路の正本から生成している（`pnpm learn:generate`）。各段の「この段を守るテスト」を集めたもので、**紐付いていない段は、守られていないとは限らない**。変更前に、その段のコードの隣の `*.test.ts` を探す。

<!-- learn:generated:start — 正本 docs/learn/journeys の JSON（test-map） / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->

経路の各段に紐付いたテストの一覧。段の「この段を守るテスト」と、経路全体を通しで守るテストを集めた。
**テストが紐付いていない段は、守られていないとは限らない**（紐付けていないだけのこともある）。変更前に、その段のコードの隣の `*.test.ts` を探す。

### Plan を保存

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/critical-path.spec.ts`](../../apps/product/src/lib/test/e2e/critical-path.spec.ts) で `test('ドラッグ選択とアクティビティ選択で明日の Plan を作成し、リロード後も残る'` を探す（E2E。保存して再読み込みしても残ることまで見る）
- **1. Plan か Record か決める**:
  - [`apps/product/src/features/timeblock/domain/timeblock-destination.test.ts`](../../apps/product/src/features/timeblock/domain/timeblock-destination.test.ts) で `it('終了が現在より未来なら Plan を返す'` を探す
  - [`apps/product/src/features/calendar/components/create/InlineCreatePanel.test.tsx`](../../apps/product/src/features/calendar/components/create/InlineCreatePanel.test.tsx) で `it('未来スロットでは記録タブが選べず、選択すると Plan を作る'` を探す
- **3. 先に画面へ出す**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.test.ts`](../../apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.test.ts) で `it('表示期間と重なる行だけを対象にする（offset付きcreateは除外）'` を探す
- **6. 関門チェック**:
  - [`apps/product/src/lib/test/integration/mfa-aal-cookie-tampering.integration.test.ts`](../../apps/product/src/lib/test/integration/mfa-aal-cookie-tampering.integration.test.ts) で `it('protectedProcedure経由でも改竄クライアントはFORBIDDEN(MFA verification required)になる'` を探す（local Supabase が要る integration）
- **8. RPC で書き込む**:
  - [`apps/product/src/features/timeblock/server/timeblock-command-client.test.ts`](../../apps/product/src/features/timeblock/server/timeblock-command-client.test.ts) で `it('tenantとnullable fieldを原子的create commandへ閉じ込める'` を探す
  - [`apps/product/src/features/timeblock/server/timeblock-command-client.test.ts`](../../apps/product/src/features/timeblock/server/timeblock-command-client.test.ts) で `it('deadlockだけをserver内で一度再試行する'` を探す
- **9. 時刻の規則で検査**:
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('rejects future Records and ignores the drained legacy link argument'` を探す（DT005 を DB で確かめる）

### Plan / Record を動かす・直す

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/timeblock-drag-move.spec.ts`](../../apps/product/src/lib/test/e2e/timeblock-drag-move.spec.ts) で `test('過去 Plan をドラッグ移動すると新しい時刻が保存される'` を探す（E2E。過去 Plan を動かして DB に残ることまで見る）
  - [`apps/product/src/lib/test/e2e/timeblock-conflict.spec.ts`](../../apps/product/src/lib/test/e2e/timeblock-conflict.spec.ts) で `test('別 writer が同じ Plan を更新すると、UI は conflict として最新値を読み直す'` を探す（E2E。Inspector の古い入力が別の場所の値を潰さないこと）
- **2. 更新を依頼**:
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx) で `it('過去の plan を過去の範囲内へ動かしても新しい時刻で mutate を呼ぶ'` を探す
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx) で `it('record を未来へ動かす更新は timeLocked トーストを出し mutate を呼ばない'` を探す
- **3. Inspector で直す**:
  - [`apps/product/src/features/timeblock/hooks/useCoalescedTimeblockSave.test.tsx`](../../apps/product/src/features/timeblock/hooks/useCoalescedTimeblockSave.test.tsx) で `it('保存中の変更を最新の差分へまとめ、直列に保存する'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('Planを別のPlanと重なる時間へ変更するとインライン表示し、保存しない'` を探す
- **4. 先に書き換える**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx) で `it('Plan updateの失敗で楽観patchした時間を操作前へ戻す'` を探す
- **6. RPC で更新**:
  - [`apps/product/src/features/timeblock/server/timeblock-command-client.test.ts`](../../apps/product/src/features/timeblock/server/timeblock-command-client.test.ts) で `it('raw microsecond CAS tokenを変換せずupdate commandへ渡す'` を探す
  - [`apps/product/src/features/timeblock/server/timeblock-command-client.test.ts`](../../apps/product/src/features/timeblock/server/timeblock-command-client.test.ts) で `it('deadlock再発、lock待ち、timeoutはclient再送向けにせず分類する'` を探す
- **7. 版と規則を確かめる**:
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('serializes concurrent Plan updates with exact compare-and-swap'` を探す（local Supabase が要る integration）
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('places and moves Plans anywhere on the timeline, and rejects retired skip'` を探す（過去・未来を問わず Plan を動かせること）
- **8. 確定して取り消しを出す**:
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx) で `it('onSuccess で showTimeChangeUndoToast が呼ばれ、Undo クリックで前の時間へ戻す'` を探す
  - [`apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx) で `it('update commandの返却行とraw versionを一覧・詳細cacheの正本にする'` を探す

### Record を作る・Plan を記録する

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/critical-path.spec.ts`](../../apps/product/src/lib/test/e2e/critical-path.spec.ts) で `test('過去帯をドラッグして Record を記録し、リロード後も残る'` を探す（E2E。入口 (3) の過去の時間帯から作る経路。「そのまま記録」を通しで守る E2E は見つからなかった）
- **1. 入口を選ぶ**:
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('時間帯の記録の有無で予定の記録操作を消さない'` を探す
  - [`apps/product/src/features/calendar/interaction/useInteraction.test.ts`](../../apps/product/src/features/calendar/interaction/useInteraction.test.ts) で `it('drop previewの終了が未来なら過去Planでも記録callbackを呼ばない'` を探す
- **2. 列へ落とす**:
  - [`apps/product/src/features/calendar/lib/plan-record-drop.test.ts`](../../apps/product/src/features/calendar/lib/plan-record-drop.test.ts) で `it('Planの内容とdrop先のpreview rangeから独立Record入力を作る'` を探す
  - [`apps/product/src/features/calendar/interaction/useInteraction.test.ts`](../../apps/product/src/features/calendar/interaction/useInteraction.test.ts) で `it('Recordレーンへのdropはplan更新ではなく記録mutationへ委譲する'` を探す
- **3. 編集を保存しきる**:
  - [`apps/product/src/features/timeblock/components/editor/TimeblockRecordActions.test.ts`](../../apps/product/src/features/timeblock/components/editor/TimeblockRecordActions.test.ts) で `it('最新編集の保存完了後にだけPlanを記録する'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('記録前にdebounceを止め、最新のアクティビティとメモをsnapshot保存する'` を探す
- **4. 記録を依頼**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockRecordMutations.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockRecordMutations.test.tsx) で `it('記録commandも自動再送を無効にする'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockRecordActions.test.ts`](../../apps/product/src/features/timeblock/components/editor/TimeblockRecordActions.test.ts) で `it('Record作成中は二重実行を無効化する'` を探す
- **6. RPC で記録**:
  - [`apps/product/src/features/timeblock/server/timeblock-command-client.test.ts`](../../apps/product/src/features/timeblock/server/timeblock-command-client.test.ts) で `it('stale versionと消えたversioned targetを別のstable codeへ変換する'` を探す
- **7. Plan を写して作る**:
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('rejects future Records and ignores the drained legacy link argument'` を探す（local Supabase が要る integration）
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('allows a Plan and Record to occupy the same time across separate lanes'` を探す
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('serializes confirm-day against one-tap Plan recording'` を探す
- **8. 出して取り消しを出す**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockRecordMutations.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockRecordMutations.test.tsx) で `it('ワンタップ記録のトーストから作った Record を取り消せる'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('記録成功後のRecord IDをInspector切替へ渡す'` を探す

### 削除と取り消し

- **経路全体**:
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.test.tsx) で `it('削除したら取り消しを出し、押すと削除後の版で復元する'` を探す（hook の単体テスト。削除と取り消しを通しで守る E2E は見つからなかった）
- **1. 入口を選ぶ**:
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockContextActions.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockContextActions.test.tsx) で `it('右クリックの削除も取り消しを出す（静かに消さない）'` を探す
  - [`apps/product/src/features/calendar/hooks/operations/useTimeblockContextActions.test.tsx`](../../apps/product/src/features/calendar/hooks/operations/useTimeblockContextActions.test.tsx) で `it('移行済みの記録は削除しない（取り消しも出さない）'` を探す
- **2. 編集を保存しきる**:
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('利用終了後は編集をflushせず既存versionで削除する'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('削除直前の保存で期限切れになっても既存versionで削除を続ける'` を探す
- **3. 先に消す**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx) で `it('Plan deleteの失敗で楽観除去した行を操作前へ戻す'` を探す
- **5. deleted_at を付ける**:
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('allows only one of a same-version Plan update and delete'` を探す（local Supabase が要る integration）
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('keeps auto-migrated Records immutable for service-role commands'` を探す
- **6. 取り消しを出す**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockDeleteUndo.test.ts`](../../apps/product/src/features/timeblock/hooks/useTimeblockDeleteUndo.test.ts) で `it('取り消しつきの削除トーストを出す'` を探す
  - [`apps/product/src/features/timeblock/hooks/useTimeblockDeleteUndo.test.ts`](../../apps/product/src/features/timeblock/hooks/useTimeblockDeleteUndo.test.ts) で `it('予定は予定として、削除が返した版で戻す'` を探す
  - [`apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx`](../../apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.test.tsx) で `it('削除結果の新しいversionでUndo復元する'` を探す
- **7. deleted_at を外す**:
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('allows either Plan restore or an overlapping create, never both'` を探す（local Supabase が要る integration）
  - [`apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts`](../../apps/product/src/lib/test/integration/timeblock-atomic-commands.integration.test.ts) で `it('allows either Record restore or overlapping create, never both'` を探す
- **8. 入れ直す**:
  - [`apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx`](../../apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx) で `it('restore commandの返却行を一致する一覧へ再挿入する'` を探す

### レポートを開く（集計）

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/critical-path.spec.ts`](../../apps/product/src/lib/test/e2e/critical-path.spec.ts) で `test('記録した実績が /report の 1 章（配分）に反映される'` を探す（E2E。カレンダーで作った Record が週のレポートに出るところまで）
  - [`apps/product/src/lib/test/e2e/derived-plan-record-flow.spec.ts`](../../apps/product/src/lib/test/e2e/derived-plan-record-flow.spec.ts) で `test('記録の同一週内移動でInspectorの一覧だけが変わり予定比は変わらない'` を探す（E2E。差分タブの予定比が Plan と Record の対応付けに依らないこと）
- **1. 期間を決める**:
  - [`apps/product/src/features/review/lib/report-tab.test.ts`](../../apps/product/src/features/review/lib/report-tab.test.ts) で `it('省略と不正値は時間の使い方へ丸める'` を探す
- **2. 集計を問い合わせる**:
  - [`apps/product/src/features/review/components/report/ReportBody.test.tsx`](../../apps/product/src/features/review/components/report/ReportBody.test.tsx) で `it('タブを切り替えても期間の query は同じ引数のまま（往復しない）'` を探す
  - [`apps/product/src/features/review/components/report/ReportBody.test.tsx`](../../apps/product/src/features/review/components/report/ReportBody.test.tsx) で `it('項目が足りない古い形の集計が復元されても描ける'` を探す
- **3. /api/trpc と関門**:
  - [`apps/product/src/lib/trpc/query-client.test.ts`](../../apps/product/src/lib/trpc/query-client.test.ts) で `it('does not retry a query rejected with TOO_MANY_REQUESTS'` を探す
- **4. Router で検証**:
  - [`apps/product/src/features/review/server/router.test.ts`](../../apps/product/src/features/review/server/router.test.ts) で `it('client 入力ではなく認証済み context の userId で集計する'` を探す
  - [`apps/product/src/features/review/server/router.test.ts`](../../apps/product/src/features/review/server/router.test.ts) で ``it('不正な粒度を受け付けない（`day` は廃止した）'`` を探す
- **5. 期間の境界を出す**:
  - [`apps/product/src/features/review/lib/report-period.test.ts`](../../apps/product/src/features/review/lib/report-period.test.ts) で `it('timezone ごとに UTC の瞬間が変わる'` を探す
  - [`apps/product/src/features/review/lib/report-period.test.ts`](../../apps/product/src/features/review/lib/report-period.test.ts) で `it('DST 開始週でも lengthMinutes は 10080 のまま（意図的に無視する）'` を探す
  - [`apps/product/src/features/review/lib/report-period.test.ts`](../../apps/product/src/features/review/lib/report-period.test.ts) で `it('隣り合う週の間に隙間が無い（1ms の穴を作らない）'` を探す
- **6. 行を取る**:
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `it('期間境界を跨ぐ記録が clip され、跨いだ先の期間にも計上される'` を探す
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `it('別ユーザーの記録・予定・アクティビティを混ぜない'` を探す
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `it('削除済み記録を除外し、残存する予定は計上する'` を探す
- **7. TS で集計**:
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `describe('ReportAggregationService.getReportPeriod'` を探す
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `it('planPast は開始が now 以下の予定だけを数える'` を探す
  - [`apps/product/src/features/review/server/report-aggregation-service.test.ts`](../../apps/product/src/features/review/server/report-aggregation-service.test.ts) で `it('アクティビティごとに 1 件の長さの度数を返し、自動移行の記録は数えない'` を探す
- **8. 派生して描く**:
  - [`apps/product/src/features/review/components/report/ReportBody.test.tsx`](../../apps/product/src/features/review/components/report/ReportBody.test.tsx) で `it('睡眠を隠すと V から睡眠分が抜け、余白の値は変わらない'` を探す
  - [`apps/product/src/features/review/components/report/ReportBody.test.tsx`](../../apps/product/src/features/review/components/report/ReportBody.test.tsx) で `it('カードの前期間比を、見えているアクティビティだけで出す'` を探す
- **9. 詳細を開いた時だけ取る**:
  - [`apps/product/src/features/review/server/report-detail-service.test.ts`](../../apps/product/src/features/review/server/report-detail-service.test.ts) で `it('分布は明細の 200 件上限に切られず、全件から出す'` を探す
  - [`apps/product/src/features/review/server/report-detail-service.test.ts`](../../apps/product/src/features/review/server/report-detail-service.test.ts) で `it('auto_migrated の記録は合計に入るが中央値からは除く'` を探す
  - [`apps/product/src/features/review/components/report/ReportBody.test.tsx`](../../apps/product/src/features/review/components/report/ReportBody.test.tsx) で `it('期間を移すと詳細パネルは閉じる'` を探す

### ログイン（MFA 含む）

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/auth.spec.ts`](../../apps/product/src/lib/test/e2e/auth.spec.ts) で `test('正しい認証情報でログインしカレンダーへ遷移する'` を探す
- **2. パスワードを確かめる**:
  - [`apps/product/src/lib/test/e2e/auth.spec.ts`](../../apps/product/src/lib/test/e2e/auth.spec.ts) で `test('誤った認証情報でエラー表示'` を探す
- **4. 6 桁のコード入力**:
  - [`apps/product/src/features/auth/components/MFAVerifyForm.test.tsx`](../../apps/product/src/features/auth/components/MFAVerifyForm.test.tsx) で `it('6桁入力でonVerifyTotpが呼ばれる'` を探す
- **6. proxy がセッションを確認**:
  - [`apps/product/src/lib/test/integration/mfa-aal-cookie-tampering.integration.test.ts`](../../apps/product/src/lib/test/integration/mfa-aal-cookie-tampering.integration.test.ts) で `it('resolveMfaAssuranceは改竄後もserver検証済みfactorsでnextLevel=aal2を要求する'` を探す（cookie を書き換えられても MFA を要求し続ける）
- **7. カレンダーに着地**:
  - [`apps/product/src/lib/safe-redirect.test.ts`](../../apps/product/src/lib/safe-redirect.test.ts) で `it('rejects absolute and protocol-relative URLs'` を探す

### サインアップ → ウェルカムメール

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/auth.spec.ts`](../../apps/product/src/lib/test/e2e/auth.spec.ts) で `test('サインアップページがフォームと規約・ログイン導線を配信する'` を探す（画面が出るところまで。登録からメールまでを通しで守る E2E は無い）
- **5. 送る権利を取る**:
  - [`apps/product/src/features/auth/server/welcome-email.test.ts`](../../apps/product/src/features/auth/server/welcome-email.test.ts) で `it('掴めなければ送らない（2 通目を出さないことがこの関数の存在理由）'` を探す
  - [`apps/product/src/features/auth/server/welcome-email.test.ts`](../../apps/product/src/features/auth/server/welcome-email.test.ts) で `it('claim が失敗したら送らず Sentry へ残す'` を探す
- **6. Resend で送る**:
  - [`apps/product/src/lib/email/send.test.ts`](../../apps/product/src/lib/email/send.test.ts) で `it('suppression に載っているアドレスへは Resend を呼ばず suppressed を返す'` を探す
  - [`apps/product/src/lib/email/send.test.ts`](../../apps/product/src/lib/email/send.test.ts) で `it('Resend が error を返しても throw せず failed(provider) を返す'` を探す
- **7. 配送結果を受ける**:
  - [`apps/product/src/app/api/webhooks/resend/route.test.ts`](../../apps/product/src/app/api/webhooks/resend/route.test.ts) で `it('transient bounce（mailbox full 等）では suppression を書かない'` を探す

### パスワードを再設定する

- **1. リセットを依頼**:
  - [`apps/product/src/features/auth/components/PasswordResetForm.test.tsx`](../../apps/product/src/features/auth/components/PasswordResetForm.test.tsx) で `再送間隔の 429 でも成功画面を出す（存在を漏らさない）` を探す
  - [`apps/product/src/features/auth/components/PasswordResetForm.test.tsx`](../../apps/product/src/features/auth/components/PasswordResetForm.test.tsx) で `captcha 失敗なら token を捨てて widget を作り直し、理由を出す` を探す
  - [`apps/product/src/lib/test/e2e/auth.spec.ts`](../../apps/product/src/lib/test/e2e/auth.spec.ts) で `パスワードリセットページがフォームと戻る導線を配信する` を探す
- **3. リセットメール送信**:
  - [`scripts/__tests__/send-auth-email-confirm-url.test.ts`](../../scripts/__tests__/send-auth-email-confirm-url.test.ts) で `攻撃者 origin の redirect_to でも token_hash は app origin にしか載らない` を探す
  - [`scripts/__tests__/send-auth-email-idempotency.test.ts`](../../scripts/__tests__/send-auth-email-idempotency.test.ts) で `同じ webhook-id の再試行では同じ key になる（重複配送しない）` を探す
- **4. リンクで着地**:
  - [`apps/product/src/app/[locale]/(auth)/auth/confirm/route.test.ts`](<../../apps/product/src/app/[locale]/(auth)/auth/confirm/route.test.ts>) で `recovery は session が立てば next を無視して /auth/reset-password へ送る` を探す
  - [`apps/product/src/app/[locale]/(auth)/auth/confirm/route.test.ts`](<../../apps/product/src/app/[locale]/(auth)/auth/confirm/route.test.ts>) で `検証に失敗したら failed を付けて結果ページへ送る` を探す
- **6. 新しいパスワードを送る**:
  - [`apps/product/src/features/auth/components/ResetPasswordForm.test.tsx`](../../apps/product/src/features/auth/components/ResetPasswordForm.test.tsx) で `通常の recovery session からの更新は成功画面へ遷移する` を探す
  - [`apps/product/src/features/auth/components/ResetPasswordForm.test.tsx`](../../apps/product/src/features/auth/components/ResetPasswordForm.test.tsx) で `未知の code は従来どおり汎用エラー判定にフォールバックする` を探す
- **7. MFA で昇格（有効時だけ）**:
  - [`apps/product/src/features/auth/components/ResetPasswordForm.test.tsx`](../../apps/product/src/features/auth/components/ResetPasswordForm.test.tsx) で `insufficient_aal では汎用エラーではなくMFA step-up画面へ遷移する` を探す
  - [`apps/product/src/features/auth/components/ResetPasswordForm.test.tsx`](../../apps/product/src/features/auth/components/ResetPasswordForm.test.tsx) で `TOTP検証成功後にupdatePasswordが失敗したら、password入力画面へ戻り再送信で完了できる` を探す
  - [`apps/product/src/features/auth/components/ResetPasswordForm.test.tsx`](../../apps/product/src/features/auth/components/ResetPasswordForm.test.tsx) で `リカバリーコード検証成功後、MFA無効化の警告つき成功画面へ遷移する` を探す
- **8. 他の端末を切る**:
  - [`apps/product/src/features/auth/stores/useAuthStore.updatePassword.test.ts`](../../apps/product/src/features/auth/stores/useAuthStore.updatePassword.test.ts) で `更新成功時は他端末の session を signOut する` を探す
  - [`apps/product/src/features/auth/stores/useAuthStore.updatePassword.test.ts`](../../apps/product/src/features/auth/stores/useAuthStore.updatePassword.test.ts) で `再試行後も失敗する場合は 2 回で諦め、更新成功の結果は失敗に変わらない` を探す
- **9. 変更通知メール**:
  - [`scripts/__tests__/send-auth-email-password-changed.test.ts`](../../scripts/__tests__/send-auth-email-password-changed.test.ts) で `suppression 済みなら Resend へ渡すメールを作らない` を探す
  - [`scripts/__tests__/send-auth-email-password-changed.test.ts`](../../scripts/__tests__/send-auth-email-password-changed.test.ts) で `suppression を判定できなければ fail-closed でメールを作らない` を探す
- **10. （別入口）設定から変更**:
  - [`apps/product/src/features/settings/components/PasswordChangeDialog.test.tsx`](../../apps/product/src/features/settings/components/PasswordChangeDialog.test.tsx) で `passes current_password to the server and never calls signInWithPassword` を探す
  - [`apps/product/src/features/settings/components/PasswordChangeDialog.test.tsx`](../../apps/product/src/features/settings/components/PasswordChangeDialog.test.tsx) で `does not mistake a captcha failure for a wrong current password` を探す
  - [`apps/product/src/lib/auth/pwned-password.test.ts`](../../apps/product/src/lib/auth/pwned-password.test.ts) で `should time out and fail safe when the request never settles` を探す

### アカウントを削除する（不可逆）

- **1. 確認ダイアログ**:
  - [`apps/product/src/features/settings/components/AccountDeletionDialog.retry.test.tsx`](../../apps/product/src/features/settings/components/AccountDeletionDialog.retry.test.tsx) で `自動リトライしない（共有レート制限の二重消費と不可逆操作の再送を防ぐ）` を探す
- **2. 本人を確かめ直す**:
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `verifyPasswordWithCaptchaBypassの直前にaccount_deletion contextでrate limitを強制する` を探す
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `再認証手段が使えなければREAUTH_UNAVAILABLEを投げて削除しない` を探す
- **3. 経路を選ぶ**:
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-selector.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-selector.test.ts) で `gateがactiveならdurable coordinatorだけを使う` を探す
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-selector.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-selector.test.ts) で `未知のreadiness failureを現行経路へ落とさない` を探す
- **4. 削除を開始（閉鎖へ）**:
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `live billing mutationとのAD019競合をretryable resultへ変換する` を探す
  - [`apps/product/src/lib/test/integration/account-deletion-gate.integration.test.ts`](../../apps/product/src/lib/test/integration/account-deletion-gate.integration.test.ts) で `blocks new Calendar, billing, and Storage writes once closing starts` を探す
- **5. Google の token を無効化**:
  - [`apps/product/src/features/external-calendar/server/account-deletion.test.ts`](../../apps/product/src/features/external-calendar/server/account-deletion.test.ts) で `DB start marker後だけproviderを1回呼びcanonical operationをfinalizeする` を探す
  - [`apps/product/src/features/external-calendar/server/account-deletion.test.ts`](../../apps/product/src/features/external-calendar/server/account-deletion.test.ts) で `start response loss後のalready_startedではproviderを再実行しない` を探す
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `外部処理後にleaseが失効したら再claimしてterminal stateを再確認する` を探す
- **6. ファイルを消す**:
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `avatarsとattachmentsを再帰列挙し100件単位で削除後に空を確認する` を探す
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `Storage listのnull responseを空扱いせずfail closedにする` を探す
- **7. Stripe を解約・削除**:
  - [`apps/product/src/features/settings/server/account-deletion.test.ts`](../../apps/product/src/features/settings/server/account-deletion.test.ts) で `全pageのopen Checkoutとcancellable subscriptionを閉じてCustomerを検証する` を探す
  - [`apps/product/src/features/settings/server/account-deletion.test.ts`](../../apps/product/src/features/settings/server/account-deletion.test.ts) で `Customer deleteの応答消失後にDeletedCustomerを確認して完了する` を探す
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `Stripe identity照合に失敗したらCalendar、Storage、Billing receiptへ進まない` を探す
- **8. 封をして本体を消す**:
  - [`apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts`](../../apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.test.ts) で `active gateではCalendar、Storage、Billingを順に完了してgeneric receiptをsealする` を探す
  - [`apps/product/src/lib/test/integration/account-deletion-gate.integration.test.ts`](../../apps/product/src/lib/test/integration/account-deletion-gate.integration.test.ts) で `replays one bounded lifecycle and checks residual Storage at final delete` を探す
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `外部データの準備を完了してからauth userを削除する` を探す
- **9. 削除完了メール**:
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `削除が確定してから通知メールを送る` を探す
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `通知メールの送信失敗では削除を止めない（削除要求を優先する）` を探す
- **10. サインイン画面へ**:
  - [`apps/product/src/lib/test/e2e/account-deletion.spec.ts`](../../apps/product/src/lib/test/e2e/account-deletion.spec.ts) で `パスワード確認 + DELETE 入力でアカウントを削除し、セッション失効と再ログイン拒否を確認する` を探す
- **11. 毎時の後始末**:
  - [`apps/product/src/app/api/cron/calendar-account-deletion-settle/route.test.ts`](../../apps/product/src/app/api/cron/calendar-account-deletion-settle/route.test.ts) で `cron の時間予算に SETTLE_WORST_CASE_MS を余裕を持って収める` を探す
  - [`apps/product/src/app/api/cron/calendar-account-deletion-settle/route.test.ts`](../../apps/product/src/app/api/cron/calendar-account-deletion-settle/route.test.ts) で `in_flight / other が残る時は warn を出す` を探す

### データを書き出す

- **経路全体**:
  - [`apps/product/src/features/settings/components/DataSettings.csv-export.test.tsx`](../../apps/product/src/features/settings/components/DataSettings.csv-export.test.tsx) で `it('exportData の plan / record を安全な CSV Blob としてダウンロードする'` を探す（component test。問い合わせの結果が CSV の Blob になって保存されるまで（期間指定は通っていない））
- **4. Service が 6 本読む**:
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `it('plans / records / categories / activities / settings をexportする'` を探す
  - [`apps/product/src/features/auth/server/user-service.test.ts`](../../apps/product/src/features/auth/server/user-service.test.ts) で `it('profileが未作成ならnullとしてexportする'` を探す
- **8. CSV か JSON にする**:
  - [`apps/product/src/features/settings/lib/timeblock-csv-export.test.ts`](../../apps/product/src/features/settings/lib/timeblock-csv-export.test.ts) で `it('defined columns以外の内部値はexportしない'` を探す
  - [`apps/product/src/features/settings/lib/timeblock-csv-export.test.ts`](../../apps/product/src/features/settings/lib/timeblock-csv-export.test.ts) で `describe('escapeTimeblockCsvField'` を探す
- **9. ファイルを保存する**:
  - [`apps/product/src/features/settings/components/DataSettings.csv-export.test.tsx`](../../apps/product/src/features/settings/components/DataSettings.csv-export.test.tsx) で `it('exportData の plan / record を安全な CSV Blob としてダウンロードする'` を探す

### Google Calendar 連携

- **10. 予定を保存**:
  - [`apps/product/src/features/external-calendar/server/sync-service.test.ts`](../../apps/product/src/features/external-calendar/server/sync-service.test.ts) で `it('connection_id と user_id を全行に載せる（複合 FK）'` を探す

### Pro を契約する（課金）

- **経路全体**:
  - [`apps/product/src/lib/test/e2e/billing.spec.ts`](../../apps/product/src/lib/test/e2e/billing.spec.ts) で `アップグレード操作で Stripe Checkout へ遷移しようとする` を探す（Stripe 自体は叩かず、tRPC の応答を差し替えて遷移と復帰の toast だけを見る）
- **1. 請求画面で購入**:
  - [`apps/product/src/lib/test/e2e/billing.spec.ts`](../../apps/product/src/lib/test/e2e/billing.spec.ts) で `アップグレード操作で Stripe Checkout へ遷移しようとする` を探す
- **2. Checkout を作る**:
  - [`apps/product/src/features/settings/server/billing-router.test.ts`](../../apps/product/src/features/settings/server/billing-router.test.ts) で `it('service role経路へoperationIdとserver-owned emailを渡す'` を探す
  - [`apps/product/src/features/settings/server/billing-mutation-service.test.ts`](../../apps/product/src/features/settings/server/billing-mutation-service.test.ts) で `it('does not create Checkout for a Customer with an existing live subscription'` を探す
- **4. 戻りの URL を読む**:
  - [`apps/product/src/app/[locale]/(app)/settings/_utils/billing-return.test.ts`](<../../apps/product/src/app/[locale]/(app)/settings/_utils/billing-return.test.ts>) で `describe('parseBillingReturn'` を探す
  - [`apps/product/src/features/settings/lib/billing-poll.test.ts`](../../apps/product/src/features/settings/lib/billing-poll.test.ts) で `describe('shouldContinueBillingPoll'` を探す
  - [`apps/product/src/lib/test/e2e/billing.spec.ts`](../../apps/product/src/lib/test/e2e/billing.spec.ts) で `Checkout 成功復帰（?success=true）で成功 toast が表示される` を探す
- **5. webhook の署名検証**:
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `describe('Stripe webhook 署名検証'` を探す
- **6. fence・照合・予約**:
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `it('write fence が有効な時は claim 前に 503 を返す（予約の滞留を避ける）'` を探す
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `it('event mode不一致はDB claim前に拒否する'` を探す
  - [`apps/product/src/app/api/webhooks/stripe/stripe-webhook-idempotency.test.ts`](../../apps/product/src/app/api/webhooks/stripe/stripe-webhook-idempotency.test.ts) で `describe('Stripe webhook idempotency'` を探す
- **7. 契約状態を書く**:
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `it('subscription checkoutをprocessedにした後で一度だけ記録し、duplicateでは再記録しない'` を探す
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `it('未対応eventを成功扱いにしない'` を探す
  - [`apps/product/src/app/api/webhooks/stripe/route.test.ts`](../../apps/product/src/app/api/webhooks/stripe/route.test.ts) で `it('解約予約中は期間終了までactiveのまま（予約時点で利用権を落とさない）'` を探す
- **8. 利用権を判定**:
  - [`apps/product/src/lib/billing/access-service.test.ts`](../../apps/product/src/lib/billing/access-service.test.ts) で `it('does not read new schema or start a trial while disabled'` を探す
  - [`packages/billing/src/access.test.ts`](../../packages/billing/src/access.test.ts) で `resolveBillingAccess` を探す
- **9. 画面へ反映**:
  - [`apps/product/src/lib/billing/BillingAccessProvider.test.tsx`](../../apps/product/src/lib/billing/BillingAccessProvider.test.tsx) で `it('starts once from the authenticated app mount'` を探す
  - [`apps/product/src/lib/billing/BillingAccessProvider.test.tsx`](../../apps/product/src/lib/billing/BillingAccessProvider.test.tsx) で `it('refetches the overview only when the access state transitions (#2669)'` を探す
- **10. Customer Portal**:
  - [`apps/product/src/lib/test/e2e/billing.spec.ts`](../../apps/product/src/lib/test/e2e/billing.spec.ts) で `Portal 復帰（?portal_return=true）では toast を出さず画面が壊れない` を探す
  - [`apps/product/src/features/settings/server/billing-mutation-service.test.ts`](../../apps/product/src/features/settings/server/billing-mutation-service.test.ts) で `it('creates a Portal Session with the canonical operation idempotency key'` を探す
- **11. 夜間の照合**:
  - [`apps/product/src/app/api/cron/billing-reconciliation/route.test.ts`](../../apps/product/src/app/api/cron/billing-reconciliation/route.test.ts) で `it('missing eventを503で可視化し、IDをresponseやSentryへ出さない'` を探す

### 問い合わせを送る

- **2. 送信 ID を決める**:
  - [`apps/product/src/features/contact/components/ContactDialog.test.tsx`](../../apps/product/src/features/contact/components/ContactDialog.test.tsx) で `it('reuses an ID only while the Product contact intent stays unchanged'` を探す
- **3. 関門と回数制限**:
  - [`apps/product/src/features/contact/server/router.test.ts`](../../apps/product/src/features/contact/server/router.test.ts) で `describe('contact router rate-limit availability'` を探す
- **5. Resend へ送る**:
  - [`apps/product/src/features/contact/server/contact-service.test.ts`](../../apps/product/src/features/contact/server/contact-service.test.ts) で `it('sends a fixed-header plain-text Product contact email'` を探す
  - [`apps/product/src/features/contact/server/contact-service.test.ts`](../../apps/product/src/features/contact/server/contact-service.test.ts) で `it('stops waiting after ten seconds while retaining the idempotency key for retry'` を探す
- **8. 配送結果の通知**:
  - [`apps/product/src/app/api/webhooks/resend/route.test.ts`](../../apps/product/src/app/api/webhooks/resend/route.test.ts) で `it('leaves Web contact events to the Web-specific endpoint'` を探す

### AI クライアントから Plan を作る（MCP）

- **経路全体**:
  - [`apps/product/src/app/api/mcp/_tools/list-tools.test.ts`](../../apps/product/src/app/api/mcp/_tools/list-tools.test.ts) で `describe('MCP list tools public contract'` を探す（tool 名・scope・公開 field の外部契約）
  - [`apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts`](../../apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts) で `describe.skipIf(!RUN_LOCAL)('MCP Plan create apply integration'` を探す（apply RPC の作成・再送・gate 閉。ローカル Supabase が無いと skip）
  - [`supabase/tests/single-plan-mcp-access.sql`](../../supabase/tests/single-plan-mcp-access.sql) で `public.set_mcp_billing_enforcement_v1(boolean,bigint)` を探す（DB 側の利用権スイッチ）
- **3. 同意して code を得る**:
  - [`apps/product/src/app/[locale]/oauth/consent/actions.test.ts`](../../apps/product/src/app/[locale]/oauth/consent/actions.test.ts) で `describe('processConsent write gate downgrade'` を探す
  - [`apps/product/src/lib/oauth-server/scopes.test.ts`](../../apps/product/src/lib/oauth-server/scopes.test.ts) で `describe('resolveGrantableScopes'` を探す
- **5. plans.create を呼ぶ**:
  - [`apps/product/src/app/api/mcp/_tools/list-tools.test.ts`](../../apps/product/src/app/api/mcp/_tools/list-tools.test.ts) で `it('descriptor、scope preflight、実登録toolの集合が一致する'` を探す
  - [`apps/product/src/lib/test/integration/mcp-read-tenant-isolation.integration.test.ts`](../../apps/product/src/lib/test/integration/mcp-read-tenant-isolation.integration.test.ts) で `describe.skipIf(!RUN_LOCAL)('MCP read tenant isolation'` を探す
- **6. /api/mcp で token を検証**:
  - [`apps/product/src/lib/mcp/auth.test.ts`](../../apps/product/src/lib/mcp/auth.test.ts) で `describe('verifyAccessToken dependency failures'` を探す
- **7. 利用権と scope の関門**:
  - [`apps/product/src/app/api/mcp/route.test.ts`](../../apps/product/src/app/api/mcp/route.test.ts) で `describe('MCP route scope preflight'` を探す
- **8. DB が書き込みを認可**:
  - [`apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts`](../../apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts) で `it('serializes parallel retries into one Plan, one receipt, and one replay'` を探す
  - [`supabase/tests/single-plan-mcp-access.sql`](../../supabase/tests/single-plan-mcp-access.sql) で `public.set_mcp_billing_enforcement_v1(boolean,bigint)` を探す
- **10. 受領証を受け取る**:
  - [`apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts`](../../apps/product/src/lib/test/integration/mcp-plan-create-apply.integration.test.ts) で `it('creates one API Plan and replays the exact receipt across timestamp representations'` を探す

### merge → 本番公開

- 紐付いたテストは無い

### テストが紐付いていない段

- [Plan を保存](journeys/save-plan.md) の 2. 作成を依頼
- [Plan を保存](journeys/save-plan.md) の 4. tRPC で送る
- [Plan を保存](journeys/save-plan.md) の 5. /api/trpc で受ける
- [Plan を保存](journeys/save-plan.md) の 7. Router → Service
- [Plan を保存](journeys/save-plan.md) の 10. 確定して取り直す
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 1. ドラッグを離す
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 5. Router → Service
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 5. Router → Service
- [削除と取り消し](journeys/delete-undo.md) の 4. Router → Service
- [ログイン（MFA 含む）](journeys/login.md) の 1. サインイン画面
- [ログイン（MFA 含む）](journeys/login.md) の 3. MFA が要るか確かめる
- [ログイン（MFA 含む）](journeys/login.md) の 5. コードを検証
- [サインアップ → ウェルカムメール](journeys/signup.md) の 1. 登録フォーム
- [サインアップ → ウェルカムメール](journeys/signup.md) の 2. Auth に登録
- [サインアップ → ウェルカムメール](journeys/signup.md) の 3. 確認メール送信
- [サインアップ → ウェルカムメール](journeys/signup.md) の 4. 確認リンクで着地
- [パスワードを再設定する](journeys/password-reset.md) の 2. Auth が token を発行
- [パスワードを再設定する](journeys/password-reset.md) の 5. 設定画面を出す
- [データを書き出す](journeys/data-export.md) の 1. 形式と範囲を選ぶ
- [データを書き出す](journeys/data-export.md) の 2. 押した時に問い合わせる
- [データを書き出す](journeys/data-export.md) の 3. /api/trpc と関門
- [データを書き出す](journeys/data-export.md) の 5. 行を読む
- [データを書き出す](journeys/data-export.md) の 6. 応答を受け取る
- [データを書き出す](journeys/data-export.md) の 7. 期間で絞る
- [Google Calendar 連携](journeys/google-calendar.md) の 1. 連携設定で接続
- [Google Calendar 連携](journeys/google-calendar.md) の 2. /start で準備
- [Google Calendar 連携](journeys/google-calendar.md) の 3. Google の同意画面
- [Google Calendar 連携](journeys/google-calendar.md) の 4. callback で検証
- [Google Calendar 連携](journeys/google-calendar.md) の 5. code を token に交換
- [Google Calendar 連携](journeys/google-calendar.md) の 6. 暗号化して保存
- [Google Calendar 連携](journeys/google-calendar.md) の 7. 設定に戻る（接続済み）
- [Google Calendar 連携](journeys/google-calendar.md) の 8. 15 分ごとの同期 cron
- [Google Calendar 連携](journeys/google-calendar.md) の 9. 予定を差分で取得
- [Google Calendar 連携](journeys/google-calendar.md) の 11. カレンダーに薄く表示
- [Pro を契約する（課金）](journeys/billing.md) の 3. Stripe の決済ページ
- [問い合わせを送る](journeys/contact.md) の 1. ダイアログを開く
- [問い合わせを送る](journeys/contact.md) の 4. 送り主を確かめる
- [問い合わせを送る](journeys/contact.md) の 6. Resend が受け付ける
- [問い合わせを送る](journeys/contact.md) の 7. 結果を出す
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 1. 401 から接続先を発見
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 2. 認可リクエストを検証
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 4. code を token に換える
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 9. 画面と同じ関数で書く
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 11. Dayopt の画面に現れる
- [merge → 本番公開](journeys/deploy.md) の 1. main へ merge
- [merge → 本番公開](journeys/deploy.md) の 2. migration 適用
- [merge → 本番公開](journeys/deploy.md) の 3. 本番候補を build
- [merge → 本番公開](journeys/deploy.md) の 4. 影響判定
- [merge → 本番公開](journeys/deploy.md) の 5. E2E などで検証
- [merge → 本番公開](journeys/deploy.md) の 6. smoke → 公開
- [merge → 本番公開](journeys/deploy.md) の 7. タブが新版に気づく

<!-- learn:generated:end -->

## 正本

- [docs/engineering/testing.md](../engineering/testing.md) — 層の表、いつ回すか、回帰テストの基準、flaky、CI 予算
- [AGENTS.md](../../AGENTS.md) のレビュー規則（TEST-1）
- `test` skill（`.agents/skills/test/SKILL.md`）— 失敗テストを先に書く手順

## 自分で確かめる問い

<details>
<summary>1. 保存時の重なり判定のバグを直す。まずどの層に赤を入れるか</summary>

重なり判定の関数がある層の Unit。DB の排他制約が関わるなら Integration。E2E は、中核の流れ（Plan → Record → Report）を壊す種類の時だけ足す。

</details>

<details>
<summary>2. 「保存ボタンが表示される」ことを確かめる E2E は、保存の修正を証明するか</summary>

しない。ボタンは修正の前から表示されている。保存した値が再読み込み後も残る、など変更後にだけ成り立つことを確かめる。

</details>

<details>
<summary>3. local で integration test が緑だった。本当に走ったか</summary>

`describe.skipIf(!RUN_LOCAL)` のように条件付きで skip される test は、条件が満たされないと skipped になっても緑に見える。passed と skipped の数を読み分ける。

</details>
