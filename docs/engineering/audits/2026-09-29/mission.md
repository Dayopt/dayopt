---
status: current
last_verified: 2026-09-29
---

# Dayopt 全体横断監査 — 継続記録

状態: **進行中・全体監査未完了**。主担当: Codex。この記録は監査の証拠であり、読了数は理解・安全性の証明ではない。

## 依頼と権限

2026-09-29 のユーザー依頼。コード・データモデル・設定・仕様・検証・必要なクラウド実態を横断して読み直し、概念の意味の不一致、型/データ境界、非同期状態遷移、実環境との乖離、検証漏れ、不要な複雑さを解消する。安全で可逆な修正は再現から修正・検証まで実施する。未決の顧客挙動・公開契約・権限・プライバシー判断、不可逆操作、外部承認/観測が必要な項目は根拠・選択肢・推奨・最悪ケース・再開条件を既存/新規Issueに残す。

repo調査、対象内の可逆修正、テスト、commit、必要なpush/Draft PR、関連Issue記録が許可されている。merge/release/production mutation、新規API課金・有料resource・追加クレジット・予算変更は未許可。クラウドは既存の許可済みread-only経路のみ。能動的検証は承認済み隔離環境と合成データのみ。秘密実値・個人情報は証拠へ残さない。

新機能・全面リライト・管理基盤の導入・抽象化・件数稼ぎは目的にしない。意図した多層防御を重複として削らない。コードやtestの現状だけで仕様を裁定しない。全文対象に未読/取得失敗が残れば部分完了とする。

## 基準と記録方法

- 読解基準SHA: `c3d55216a360aa1ce387faa7f0000d0d6f8fc869`
- 開始時checkout: `/Users/tanakatomoya/.codex/worktrees/1c23/dayopt`。detached、未コミット差分なし。
- 作業branch: `codex/audit-cross-layer-consistency`
- 基準追跡対象: 3,141ファイル / 30,771,381 bytes。
- `inventory.json`: 全追跡path、基準SHA/blob/mode/bytes、確認方法、状態、理由、読解済み行範囲、証拠、未解決疑問。初期分類は全文3,060・機械81。生成/履歴候補は生成元・利用状態を確認するまで全文対象のまま。
- `full-text` は全行が省略なくモデルに提示され、照合した後のみ完了扱い。コマンドで取得しただけ、出力がtruncated、検索hitだけの場合は未確認のまま。大きいファイルは行範囲を分割する。
- 機械対象も検査前はunverified。symlinkはcanonical先を別途読む。binaryは形式/参照/生成元、lockfileはmanifest/依存graph/整合性を確認する。
- 開始後の変更は基準との差分と影響先を再読する。読解SHA・修正SHA・検証SHA・配信SHAを別に記録する。

## 作業方針

1. 規則・仕様・決定・現在のIssue/PRと進行中レーンを確認する。
2. 重要概念ごとに定義→入力→判定→保存→出力→検証を追い、全pathの読解を進める。
3. 所見は期待契約/条件/証拠水準/影響/既存Issue/反証/修正方針を記録する。重大な結論は原文と実行結果へ戻る。
4. 修正前失敗→修正後成功の適切な検証を実施し、組み合わせを検査する。却下候補にも理由を残す。
5. 可逆修正を完遂し、外部判断待ちは分離して独立作業を継続する。最終的に未読・未追跡所見をなくす。

## 現在確認した境界

- `routing` はread-only + repository scopeをruntimeで強制できないdelegateを禁止。利用可能なnative collaborationは同じ全権限環境を共有するため使用していない。Luna利用自体はユーザー許可済みだが、runtime境界を満たす経路は未確認。規則は変更していない。
- Node実測: 既定v26.5.0、`.nvmrc`は24、`/opt/homebrew/opt/node@24/bin/node`あり。検証ではNode24を使う。
- 開始時open PR: #2957 / #2956 / #2954 / #2937 / #2926 / #2903 / #2833 / #2670。Cloud Preview、GitHubラベル、schema/OAuth、外部calendar、法務、billing公開表示の変更と衝突させない。API取得時点のsnapshotであり完了証拠ではない。
- #2958 はStorybook開発基盤の別Mission。#2910はCloud Preview環境。関連作業は本文・ctxから再確認してから扱う。

## 取得上の注意

初回のAGENTS/routing/secrets一括出力、memory検索、Issue一覧にtruncationが発生した。省略箇所は読了にしない。routing/dispatch/github-labelsは独立した取得で全文確認済み。secretsは分割再取得を完了。Review仕様/test skill/package.jsonの省略箇所も追加取得で回収した。memoryは過去の状況探索にのみ使用し、現在状態をそこから確定しない。

## 次の着手点

監査Issue: [#2963](https://github.com/Dayopt/dayopt/issues/2963)。`pnpm ctx 2963 --reuse-brief-l1` はexit 0、L1は `trusted_brief_missing_or_stale`。L1は未取得として本文と一次資料で続行。API課金を伴うJev呼び出しは行っていない。ctx初回起動時に既存lockfileから依存のinstallが行われた。tracked manifest/lockfileの差分は無い。

全文確認202ファイル、symlink機械確認1件、未確認2,938件。`inventory.json`が各pathの確認範囲の正本。secrets/architecture/conventions/testing/glossary/strategy/decisions、Reviewの主経路、activities featureの基準ファイル全件の全文確認を完了。partial readは別に範囲を記録した。全文確認は全境界の実行検証を意味しない。全体監査は初期段階であり、多数の未読が残る。

修正commit: F001 `f0151baaf`（作成既定と選択）、F004 `f2a43d559`（unknown/型アサーション）、F002 `e88a1890f`・`84f4d9019`（旧レポート説明と用語test）、F006 `c799b402b`（前期間だけの活動が比較から消える不具合）、F008 `8a5bc2c9f`（test時計固定）、F011 `9851013ae`（機械データによるtaxonomy誤検知）、F010 `befb03e5f`（DSTの時間帯集計）。`findings.md`に根拠・反証・検査結果を記録。

追加修正: F012 `9a3574988`（archived categoryの古い非表示設定がレポートに残る）、F013 `93d0774da`（分類変更・undo後にreview cacheが更新されない）。それぞれred→green、関連86件/39件成功、F013のtypecheck:product成功。公開済みSHAと最新検証SHAは区別する。

追加差分の統合検査は `6c859b9d7bbf8ab576390bdc97acbe80f9ce28cf` の製品コードで実施。`pnpm check` はtypecheck/lint/static、billing15・i18n2・observability64・product4333・web366が成功し、scriptsは2624 passed / 1 failedでexit 1。失敗は新規testファイルに伴うArchitecture Mapの生成資料2枚の更新漏れ。`pnpm architecture:generate`でactivitiesのtest件数3→4とpath1行だけを更新し、対象architecture-map test59件と`pnpm docs:check`は成功。ログ `/tmp/dayopt-audit-check-categories.log`、`/tmp/dayopt-audit-architecture-map.log`、`/tmp/dayopt-audit-docs-categories.log`。この段階でcheck全体のexit 0を再取得したとは報告しない。検査中に監査読解記録だけを追記したが、製品コードは固定。保護path gateは追加差分を含めてもrequired=false/auditContract=false。

全体`pnpm check`を3回実施。初回は基準から未変更のtemplate testの実時計依存2件で失敗。時計固定後はproduct 4,320 / web 366件成功、scriptsで廃止語と機械一覧の誤検知2件が失敗。両方を修正しscripts全体2,625件成功、typecheck:scripts成功。その後F010を追加し、期間・時間帯・両serviceの88件成功。最新検証SHA `79a1a6c2392312fc2552b5e909ebdf784e7b31fd`の`pnpm check`はexit 0（型/lint/static/deadcode、billing15・i18n2・observability64・product4330・web366・scripts2625件、計7402 passed）。同HEADのpre-pushも通常フックで成功。ログ `/tmp/dayopt-audit-check-final.log` と `/tmp/dayopt-audit-push-verified.log`。1年にclipした合成記録のDST集計は525600分、ローカル計測152ms。クラウド実態照合・配信は未実施。

Draft PR [#2965](https://github.com/Dayopt/dayopt/pull/2965)へ保存済み、milestone v0.36、チャットにattach済み。Issue進捗コメント: https://github.com/Dayopt/dayopt/issues/2963#issuecomment-5886921886 。DraftのためGitHubのStatic/Unit/Integration等はSKIPPEDでありCI成功とは扱わない。mainは基準SHAのまま（PR作成時read-only確認）。merge/releaseなし。

次はH007（分類の件数上限と単一snapshot契約）、H014/H015（分類・詳細パネルの失敗/復元/中断）、H003（環境レーン）、H005（MCPの確定契約）を照合する。#1825・#2162本文とPR #1841本文・対象一覧、旧tagsの修正diff `d75b1f339`を確認済み。旧tagsはcount:exactによる切り捨てwarnがあり、現行activitiesには無い。#2910はctx実施（L1未取得）、原文を`tmp/dayopt-issue-2910.md`に保存し、truncation箇所を回収して全文確認した。最新コメントでは共有DB検証が他レーン都合で保留されたとの自己申告がある。これは本監査のcloud実測証拠ではない。`docs/learn/journeys/mcp.md`の1399行出力はtruncatedで未読を残したため、次は分割取得する。

Supabase pluginとmcp-usageに従い、既存production-db-readonly/helperを全文確認してから、許可済みop run経路で非個人system metadataだけのread_only照会を試行。認証初期化が2026-09-29 18:02 JSTにauthorization timeoutで終了し、DB結果は未取得。transaction_read_only / server_version / max_rows設定 / activities・categoriesのRLSフラグは未確認のまま。秘密実値・個人データの取得/出力やDB書込なし。新規MCP登録・権限変更・同じ失敗の反復をせず、独立したrepo読解を続ける。

現在の修正を全体監査完了とは扱わない。安全な修正は順次検証する。終了/コンテキスト更新のたびにここ・inventory・findings・Issueの証拠を同期し、未読をゼロから読み直さない。

## 追加検証 — UI中断とMCP説明

F016 `eb07b33eb`はReview/Calendarのresize中断後のlistener/body style残留、F017 `0c299a246`は改名失敗後の未処理Promise rejectionを再現して修正。関連42 tests・型検査、改名2 tests成功。F018はMCPのplan_created送信に関する古い説明のみ訂正し、既存generatorで正本JSONから本文/逆引き資料を同期。

製品コードSHA `0c299a246efee881f551ff13375c523b30c97904` + Architecture Map生成資料更新で `pnpm check` がexit 0。typecheck10 tasks・lint9 tasks・静的検査、billing15・i18n2・observability64・product4341・web366・scripts2625、計7413 passed。ログ `/tmp/dayopt-audit-check-interruptions.log`。検査中の変更は監査記録とMCP説明だけで、製品コードは固定。新しいtestファイルのpath/件数は検査前にgeneratorで同期済み。生成後 `pnpm docs:check` もexit 0、ログ `/tmp/dayopt-audit-docs-interruptions.log`。追加差分もprotected-path-gateはrequired=false/auditContract=false。

`docs/learn/journeys/mcp.md`の基準1399行は分割で全文回収済み。MCP tool登録/input/output、mutation client/DB adapter/contract、analytics送信と既存testも全文確認。次はDB apply定義とユーザーの明示判断へ戻り、ghost原則とcanonical書込契約を裁定する。H014の改名失敗とH015のresize中断以外の仮説は未解決。

引き続きDraft #2965を維持し、merge/releaseは行わない。未読2976件を完了扱いせず、H003/H005/H007/H009とH014/H015の未解決部分を継続する。

## main更新の取り込み

2026-09-29 18:31 JST、mainが `0bcdb864127feea425934baa179797bd53ecf375`（PR #2964）へ進んだことをread-onlyで確認。基準からの17ファイル/1071行のdiffを分割して省略なく確認し、監査ブランチへmerge commit `f85b255a2b4b85301c805b99c4d5f2dac31705b4`で取り込んだ。mainへのmergeではなく、外部状態の変更もない。

競合5ファイルは、同じ9月7日の作成契約・同じ9月5日の固定時計を維持するmain側へ解消。Timeblock説明の古いskip/逆リンク要約を復活させず、glossaryの廃止済み3章とledger-barをmainと同じく撤去。監査側のテーブル行単位のglossary test、集計・cache・resize・改名の修正は保持。型・runtimeの差分はなく、変更されたtemplate testは10 passed（`/tmp/dayopt-audit-main-template.log`）。統合後のscripts/docs/pre-pushは別に記録し、統合前checkの7413件を統合後の実行結果とは混同しない。

基準inventoryは開始SHAを維持し、各17pathへdelta確認の証拠を追記。差分だけ読んだ未読ファイルを全文確認へ昇格していない。PR #2964のrouting変更は判断索引の参照補強で、native委譲のruntime制約は緩和されていない。

## MCPの直接書き込み契約の裁定

H005は#1754の2026-08-26 User裁定原文を取得してF005へ採用。直接書込みの現scope出荷は明示選択、proposal-onlyは将来phaseの検討であり、DBとtoolの現行実装をghost化する修正は不要。strategy/principlesの古い全入口ghost説明だけを`1715af0d8`で修正、docs:check exit 0。新しい決定をagentが作ったのではなく、既存判断の適用範囲を復元した。

6 migrationを追加で全文読解し、authorize→operation lock→digest replay→canonical command→期限再確認→receipt保存を照合。旧digestの互換保持は既存#2736が配備・90日保持・最終撤去の証拠を持つため削除しない。クラウド反映・実DB実行は未確認。次はH019（DM008がtoolで再試行可になる候補）を実adapter→toolで反証し、MCP createの古いfuture限定説明も照合する。H007/H009/H014/H015と全体の未読は引き続き残る。

今回の文書修正と追加読解はlocal commitで保存。直前に公開済みのDraft #2965のheadは`4d7ff84068c843d5b9117d211beec5fea0b679f1`。次の修正を束ねた時に通常pre-pushを通して更新する。前回の統合後pre-push（scripts2625件・affected型/lint・format）成功は `/tmp/dayopt-audit-push-main-verified.log`、統合後docs成功は `/tmp/dayopt-audit-docs-main.log`。

## 削除後の再送と公開ツール説明

H019をSDK→tool→実adapterの境界で再現し、F019として`bbc0dfe8e`で修正。削除済みreceiptのDM008は既存NOT_FOUND/非再試行、未知DB障害は引き続き再試行可能。red 2 failed / 2 passed、green関連42 testsと型検査成功。DB結果は合成で、本番/クラウド検証ではない。

F020は既存判断とDB applyに合わせ、plans.createの未来限定説明だけを訂正。learn正本/生成先も同期する。MCP adapterとtoolの変更を含むため、以前のprotected-path-gate required=falseを今回の差分へ流用しない。Draftのまま通常の検査・公開を行い、merge/releaseしない。次は統合検査と公開済みSHAを記録して、残る全文読解を継続する。

OAuth/MCP入口・host/identity・token検証・scope・gate・service-role bridge・code exchangeの全文読解を追加。MCPの読み取りtoolでもverifyAccessTokenがlast_used_atを書き込むため、cloud read-only照合として呼ばない。token用とconnection用の検査、runtimeとDBのwrite gateは別責務で、同一ルールの不要重複としては削除しない。共有barrelがtrpc-bridgeを再exportしないのは循環回避の意図が明記されており維持する。DB内のexchange/rotation、UI consent、認証関連testの未読は引き続き追跡する。

F020説明修正commit `057697dfe`。protected-path-gateの実行結果はrequired=true（apps/product/src/app/api/mcp/**）/auditContract=false。MCP修正を含む安定したmerge候補の独立レビューは通常経路で必要だが、現段階は監査中のDraftであり、早期にreviewerを起動していない。

## MCP修正後の統合検査

製品コードSHA `057697dfe`（MCP説明を含む）でNode24の`pnpm check`がexit 0。型10 tasks・lint9 tasks・静的検査、billing15・i18n2・observability64・product4345・web366・scripts2625、計7417 tests passed。ログ `/tmp/dayopt-audit-check-mcp-replay.log`。検査中は製品コードを固定し、読解記録のみ追記。Architecture generatorは先に実行、今回は差分なし。前回成功の流用ではなく、main統合と今回MCP修正を含む結果。実DB・E2E・CI・配信の証拠ではない。
