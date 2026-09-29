# 隔離 Preview の fixture 認証経路（#2910）

DB 変更 PR の Supabase branch でも、毎 PR の secret 保存や手動 signup をせず、合成ユーザーの通常ログインと所有データ回収を実行するための実装計画。

## 現在の状態

実装済みなのは [短命認証コア](../../scripts/lib/preview-fixture-authority.mjs) と [予定ユーザーの実行処理](../../scripts/lib/preview-fixture-broker.mjs)。実行処理は、永続的に操作順と終了状態を管理する adapter が渡されなければ、管理キーを読む前に拒否する。実 adapter、broker API、fixture の寿命、workflow の job 分離にはまだ接続していない。既存の共有 Preview runner の認証や権限は変更していない。

ローカルの署名・拒否テストが成功しても、GitHub の実 OIDC 発行、Preview サーバーの system env、実際のログインや回収が動いた証拠にはならない。共有 Integration が別の検証で凍結中なら、source 作業だけを進める。

## 目標と最小構成

信頼済み workflow job が、事前保存した公開 intent の予定 2 UUID を対象に作成・回収する。管理キーは対象の immutable Product Preview サーバー内に残し、candidate の install / Playwright job には合成ログイン情報だけを渡す。任意 SQL、任意 table / user、管理キー取得 API は作らない。

OIDC の `id-token: write` は信頼済み job だけに付ける。candidate job にこの権限や `ACTIONS_ID_TOKEN_REQUEST_*` を渡してはならない。これは candidate server source の sandbox ではないため、既存のレビュー済み SHA と trusted source 一致の契約も維持する。

利用者の操作数は現在の workflow dispatch から増やさない。新しい dashboard、Vercel project、独自 domain、長期 secret 保管先は不要。

## コアの契約

`prepareFixtureAuthority` は `intent / execution / operation / origin` を正規化する。intent は既存 [preview-cloud-intent.mjs](../../scripts/ci/preview-cloud-intent.mjs) と同じ公開予定情報。execution は現在の workflow SHA・run ID・attempt。operation は `provision / cleanup / recover` だけで、全入力の digest を audience に含める。通常操作は元 attempt と一致し、recover は別の独立 attempt に限定する。

`requestFixtureJobToken` は現在の Integration workflow context を確認して、GitHub Actions の HTTPS endpoint にだけ request bearer を送る。redirect を拒否し、返された JWT を同じ署名検証器で確認してから返す。caller は JWT を memory に保持し、ログ・argv・公開 artifact に出さない。

`verifyFixtureJobToken` は固定 GitHub issuer / JWKS、RS256 署名、期限、repository と owner の immutable ID、environment、workflow / ref、event、runner、SHA / run / attempt、audience を照合する。JWKS 取得後にも期限を検査する。provider body や token を含み得る失敗は固定エラーへ変換する。

`assertFixtureBrokerTarget` は Product project、Preview、immutable URL / deployment、Git SHA / branch、選択した非本番 DB URL の一致を要求する。shared / Production への fallback はない。**この検査と JWT 検証の両方が成功してから管理キーを読み、操作する。**

repository ID / owner ID / 既定 subject は 2026-09-29 の repository metadata と OIDC customization 設定を照合した値。repository 移転や subject 設定変更では自動的に緩めず、契約を再確認する。

## 作成・回収処理と未実装の永続制御

実行処理は両 UUID の Auth ownership を最初の変更前に照合する。作成は run と UUID に結び付けた合成 login を用意し、Auth の作成応答が失われても読み戻して所有を確認する。途中までの seed は同じ category / activity ID で再開し、既存の別ユーザーの行を上書きしない。ready 済みの再試行では password や seed を書き換えない。管理キーをローテーションした場合は既存 fixture の generation 不一致で停止し、元 intent による回収は許可する。

回収は所有 Auth user の削除と不存在確認に加えて、profiles / user_settings / categories / activities / plans / records の残留 count が全て 0 であることを要求する。片方の削除失敗で他方の回収を打ち切らず、失敗は固定エラーとして残す。

独立レビューでは、遅延中の provision が cleanup 成功後に user を再作成する競合を確認した。実行処理が必須とする `withLifecycle` adapter は次の全条件を満たす必要がある。

- database ref と run UUID をキーに、全 operation をサーバーインスタンス間で直列化する。operation ごとに異なる audience を lock key にしない。
- intent digest を固定し、同じ key への異なる intent を拒否する。
- cleanup / recover の開始時に終了状態を永続化し、回収失敗でも保持する。以後の provision は拒否し、cleanup / recover の再試行だけを許可する。
- worker / server 喪失後も、未確定の外部 Auth request が残る間に回収成功を返さない。単なる期限付き lease やプロセス内 mutex だけではこの条件を満たさない。

実 adapter の最小案は、既存の対象 DB に操作状態を永続化し、応答不明や実行サーバー喪失を `UNKNOWN` として閉じること。SDK の外側で fencing token を確認しても、送信済みの Auth 作成要求の commit は止められない。時間経過だけで `UNKNOWN` を回収成功へ戻さず、この場合は所有する ephemeral branch の削除と DB 自体の終端確認を必須にする。branch metadata の 404 だけを DB 不在の証拠にしない。この案の provider 終端条件・実装・実測は未完了であり、既存 executor の回収成功をこの保証の代わりに使わない。

executor は adapter の取得待ち後にも JWT の期限を再検証する。[SDKを用いるローカルテスト](../../scripts/lib/preview-fixture-broker.test.ts) は provider mock と test-only の coordination harness を使い、この呼び出し契約と競合を検証する。**実 adapter の永続性・インスタンス間の排他・worker 喪失からの回収を証明するテストではない。** その実装・実測前に公開 route へ接続してはならない。

## 準備済み login を使う candidate 側

[registry reader](../../apps/product/src/lib/test/preview-fixture-registry.ts) と既存3specに、`E2E_PREVIEW_FIXTURE_REGISTRY` が指定された場合だけ有効な consumer 経路を用意した。現在の runner はこの変数を渡さないため、broker / workflow への接続は未完了のまま。

registry は provision 応答の `schemaVersion / operation / runId / users` に、信頼済み caller が `origin / supabaseProjectRef` を付けた JSON。予定2ユーザーの通常 login だけを含む。reader は immutable origin、ephemeral DB、run、予定UUID、メールとseed名を照合し、不正・不足・追加fieldは固定エラーで拒否する。admin key / provider PAT / OIDC発行変数を持つconsumerも拒否する。job全体のenv allowlistは引き続き必須で、このreaderを任意の環境変数の無害化器と扱わない。

file は600、親directoryは700、16KiB以内とし、file symlinkを拒否する。公開evidenceだけでなくPlaywrightのoutputDirの外に保存する。Playwrightは起動時にoutputDirを消去するため、credentialsとbrowser出力を同じ場所へ置かない。生のlogin fileをartifactやログへ載せない。

consumer時はspecごとのadmin生成・seed・削除を行わず、同じ2ユーザーを通常loginで使う。Preview configで **desktop6件 → mobile5件 → A/B認可1件** のproject依存を明示し、認可テストのRecordが先にReport集計へ混ざらないようにする。先行失敗時の後続skipは成功にしない。全project後の回収は別のtrusted jobが担当し、worker喪失時も予定intentから回収できる必要がある。legacyモードのspec別作成/削除は維持する。

`previewWorkerEnvironment` は信頼済み caller が registry path を明示した場合だけ、検証済み readiness の ephemeral binding・immutable origin・run・予定2UUIDを確認し、管理キーを含まないenvを組み立てる。親envのregistry指定は無視する。GitHub token、provider PAT、OIDC発行変数、NODE_OPTIONSは引き継がず、Preview到達用bypassと通常loginのprivate file pathだけを既存allowlistへ加える。file内容の検証はconsumer readerが行う。現在のrunner呼び出しは追加引数を渡さず、従来動作を維持する。同一jobでenvを絞るだけでは、悪意あるcandidateから親プロセス・filesystemへのアクセスを隔離できないため、trusted/candidateのjob分離を省略してはならない。

このreader・spec経路・`--list` の検証は、private fileの作成/安全な受け渡し・broker実行・通常login実走・最終回収を証明しない。それらはworkflow接続と実測の未完了条件として残る。

## 既存処理と組み合わせる順序

1. [preview-cloud-trust.mjs](../../scripts/ci/preview-cloud-trust.mjs) と readiness で exact candidate / deployment / branch / schema を確認し、公開 intent を candidate checkout 前に保存する。
2. 信頼済み provision job だけが audience を指定して OIDC を取得し、対象 Preview へ送る。
3. server が target と署名を確認後、予定 2 UUID の衝突・所有を検査して固定 fixture を作る。private な合成 login registry を作成する。
4. 権限を持たない candidate job が通常ログインで CRUD / Report / A-B 認可を実行する。desktop / mobile の Report へ認可試験の Record が混入しない実行順と寿命を明示する。
5. 別の信頼済み cleanup job が予定 UUID の ownership を再確認して回収する。
6. worker が失われた場合は [preview-cloud-recovery.mjs](../../scripts/ci/preview-cloud-recovery.mjs) の元 failed / cancelled attempt と artifact 検証を先に行い、新しい audience と OIDC で回収する。認証コア自体は元 artifact や readiness の検証器ではない。

## 可逆性と実環境の合格条件

source と workflow は Git で復元できる。実証時の mutation は選択した ephemeral branch と所有 fixture のみに限る。Production や共有 baseline は変更しない。マージできない場合は exact branch の所有と非 persistent を確認して削除する。

接続前後に次を確認する。

- Production build の routes manifest に broker が存在せず、Preview build にだけ存在すること。runtime の無効化だけでは足りない。
- candidate job に OIDC 発行能力や admin key がなく、private login file が公開 artifact に入らないこと。
- 同じ exact candidate で migration / seed / 通常 login / CRUD / Report / A-B 拒否 / cleanup が実行できること。
- 元 worker / journal が失われても別 job が予定 2 UUID だけを回収し、foreign user と baseline が保持されること。
- 次の PR / branch 再作成でも手動の secret 保存が不要であること。

根拠: [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)、[Supabase branching integrations](https://supabase.com/docs/guides/deployment/branching/integrations)、既存の intent / trust / owned cleanup source。
