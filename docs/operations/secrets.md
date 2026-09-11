---
status: current
last_verified: 2026-09-07
code: scripts/tasks/env/schema.ts
---

# Secrets Management

このページを Dayopt の Secrets 運用の正本とする。1Password が長寿命 secret の master で、ローカルファイル・Vercel Env・GitHub Secrets・Supabase Dashboard secrets は replica として扱う。

---

## 基本方針

1. **1Password is master** — secret / token / recovery 情報 / 接続情報は 1Password を正とする
2. **local does not store real secret values** — ローカルに置くのは `.op-env.agent` の `op://` 参照だけ
3. **external environments are replicas** — Vercel / GitHub Actions / Supabase Dashboard は 1Password から同期される複製
4. **値を表示しない** — 確認は存在確認だけにし、secret 本体を terminal / docs / issue / chat に出さない
5. **Turnstile is canonical** — bot protection は Cloudflare Turnstile を正とし、reCAPTCHA は旧方式として扱う
6. **contact credentials are separated** — app配送、app別webhook署名、Gmail返信SMTPの権限を共用しない
7. **値がどこに存在していようと、必ず 1Password にもある** — 1Password は消費元ではなく完全な台帳（インデックス）。消費は直接参照でも replica でもよいが、replica にしか無い値が存在してはならない（2026-08-13、User との認識合わせ。経緯は #1933）

PR ごとの Supabase Preview Branch credentials は例外。Supabase / Vercel integration が作る ephemeral replica であり、1Password には保存しない。

`.env.local` に実値を置く運用は廃止。Vercel CLI などで一時生成された `.env.local` は unsafe / temporary として扱い、作業後に削除する。

---

## AI エージェントの env ファイル境界

この境界は provider を問わず、Dayopt の workspace を読む・書く全 coding agent に適用する。OpenAI / Codex を primary harness とし、Claude Code など他 provider も同じ規約を読む。規約の正本は本節、共有判定ロジックは `scripts/hooks/pre-tool-guard-rules.mjs` に置く。

provider ごとの入口は薄い adapter として分ける。

- Claude Code は `.claude/settings.json` から `scripts/hooks/pre-tool-guard.mjs` を呼ぶ
- Codex 用の入口は `scripts/hooks/codex-pre-tool-guard.mjs`。Codex の tool-call payload を共有 rules の入力へ変換する
- 他 runtime は共有 rules を呼ぶ adapter が登録されている場合だけ同じ機械判定を受ける。adapter が無ければ本節と `AGENTS.md` の規律だけが適用される

**script が repo に存在するだけでは強制力にならない。** runtime が該当 adapter を tool 実行前に登録・起動し、block 結果を尊重する場合にだけ、その runtime 内の対象 tool call を止める。repo は user-global Codex 設定や未知の provider の hook 登録を保証しない。直接 shell、User 自身の UI 操作、adapter が受け取らない tool surface、意図的な文字列組み立てまで閉じる security boundary とは表現しない。hook は事故を減らす speed bump で、production mutation の最終境界は `AGENTS.md` の EXPLICIT AUTHORITY とサービス側の認証・承認である。

Codex では project 初回利用時に trust を確認し、`/hooks` で `.codex/hooks.json` の command と有効状態を User がレビューする。`pnpm agent:preflight --json` の `codexHooks: "configured; runtime activation unverified"` は設定ファイルの存在だけを表し、runtime trust や hook の発火を証明しない。この移行は user-global Codex 設定を変更しない。

**触ってよい（読み書き可）**:

- `.op-env.agent` / `.op-env.agent.example` — 中身は `op://` 参照のみで実秘密なし（app ごとの `.env.example` は 2026-08-14 に廃止した。変数一覧の正本は `scripts/tasks/env/schema.ts` で、手動維持の重複コピーは drift 源にしかならないため）
- `.op-env.human` / `.op-env.human.example` — 中身は `op://` 参照だけで実秘密は含まない。旧境界（作成・読み書き禁止）は 2026-08-13、User 決定（[#1993](https://github.com/Dayopt/dayopt/issues/1993)）で緩和した。読み・作成・編集は解禁し、境界は**消費**（`op run` にこのファイルを `--env-file` として渡す実行経路）だけに絞る。中身は参照 path のみで無害だが、消費すると production の service role key が解決される実行経路が用意されるため、消費は User の明示操作に限る。agent は schema の更新（`.op-env.human.example` の編集）だけでなく、`.op-env.human` 自体の作成・編集もできる。**enforcement は消費側だけに残す**: `pre-tool-guard-rules.mjs` の Bash 側ガードが、`--env-file` が `.op-env.human` 系（雛形含む）を指す実行を拒否する。`.claude/settings.json` の `deny`（旧 `Write` / `Edit`）は撤去した。契約は `scripts/__tests__/pre-tool-guard.test.ts` が固定する（作成・書き込みは許可、直後の消費は block、を両方 assert する）
  - **雛形も消費側の対象に含める**（`.op-env.human.example` は `op://human/...` の参照をそのまま持つため、コピーせず `op run` に渡すだけで同じ本番権限が解決される）

**共有 rules が adapter から呼ばれた時の判定境界。** 消費側は **allowlist で判定する**。`--env-file` に渡してよいのは `.op-env.agent` だけで、それ以外は中身を問わず落とす。

禁止する側を数え上げる方式には 2 段階で穴が見つかった。第一に、`op` がコマンド位置に来る形だけを見ると `env op run` / `command op run` / 絶対パス / `sh -c "op run …"` / `xargs` で迂回できる。第二に、`--env-file` が `.op-env.human` 系を指す場合だけを落としても、**雛形を別名へ複製すれば破れる**（`cp .op-env.human.example /tmp/foo` → その別名を `op run` へ）。path 名から中身は判別できない以上、許可する側を固定するしかない。新しい env-file を足す時はガードも更新する（増やすこと自体を意図的な判断にするため）。

**判定は fail closed で、path 文字列そのものを allowlist にする。** 許可するのは repo 直下（`.op-env.agent`）、明示 `./` 付き（`./.op-env.agent`）、workspace からの相対（`../../.op-env.agent`）の 3 形式だけ。

ここに至るまでに、緩い判定は 2 通りの穴を開けた。「path らしくない token は無視する」例外は quote / backslash escape を含む path を検査対象から外し、空白入りの別名で迂回できた。basename での判定は、任意ディレクトリに同名で置くだけで通った（`cp .op-env.human.example /tmp/.op-env.agent`）。token を分類したり path を正規化したりせず、許可形の literal 以外はすべて落とす。

adapter が共有 rules へ渡したコマンド文字列では、列挙した静的な path 表現を拒否する。起動方法（`env` / `command` / 絶対パス / `sh -c` / `xargs`）、別名、quote / escape、別ディレクトリの同名ファイルは許可形の literal に一致しないため落ちる。runtime が adapter を呼ばない経路と、後述する実行時の文字列組み立てはこの保証に含めない。

**flag の書き方も allowlist で判定する。** path を allowlist にしても、**flag と path の書き方を変えれば照合に入らない**（`--env-file"=…"` のように `=` の前へ引用符を刺すと、トリガーの正規表現に一致せず素通りした）。regex でコマンド文字列を見る限り shell の引数解釈は再現できず、同じ argv に落ちる書き方は無数にあるので、変形を数え上げるのをやめた。**`-env-file` という言及が 1 つでもあれば、その言及が全部「flag + `=`/空白 + 許可 literal + 区切り」でない限り落とす。** 加えて引用符と backslash を除いた写しでも同じ判定を行い、どちらかが落ちたら落とす（flag 名の内側へ引用符を刺す `--env-f"ile"=…` はこの写しでしか捕まらない）。

**path が allowlist を通っても、中身を検査する。** `.op-env.agent` は agent が書ける（本節の「触ってよい」）ので、そこへ `op://human/…` を書き足せば path トリックなしで production credential に届く。そこで **`op://` の vault を allowlist で判定する** — 通すのは `agent` だけで、それ以外を参照する env-file は落とす（2026-08-14 の信頼境界軸再編 #2086 で、旧 3 vault の列挙から `agent` 1 つに縮んだ）。`human` / `ci` を禁止する形にしないのは、vault が増えた時に穴が開くため。検査は 3 層に置く:

1. **実行時** — 許可形を通った env-file の実ファイルを読み、許可外 vault があれば落とす。ファイルが無ければ解決される参照も無いので通す
2. **消費は単一の単純コマンドに限る** — hook は Bash 呼び出しごとに実行前 1 回しか発火しないので、同じコマンドの中で先に書き換えられると 1 が**書き換え前**を読む（`echo … >> <env-file> && op run …`）。書き手を数え上げる方式は閉じない（`cp` / `tee` / `sed` / リダイレクトを列挙した実装を、`python3` / `node` / `>|` がすり抜けることを実測した）。**書き手ではなく「別のことが起きる余地」を落とす** — 区切り（`;` `&` `|` 改行）、コマンド置換（`$( )` / backtick）、プロセス置換（`<( )` / `>( )`）、`eval` のいずれかがあれば拒否する。リダイレクトは別のコマンドを走らせないので許す。この列挙は書き手やコマンド名と違って **shell の文法側で閉じている**。flag の言及判定・path の抽出・この単一コマンド判定は、生の文字列と引用符を除いた写しの**両方**で行う（片方だけだと `--env-f"ile"=…` がどの検査にも載らない）
3. **書き込み時（Write / Edit）** — `.op-env.agent` / `.op-env.agent.example` へ許可外 vault を書くこと自体を落とす。1 は agent が `op run` を直接打つ場面でしか発火しない（`pnpm typecheck:op` などは npm script の内側で `op run` するので hook から見えない）ため、書き足しを発生源で止める。**これは best-effort で、権威は 1 の方**。この層が見るのは書き込まれるテキストだけなので、`agent` → `human` のように **`op://` を含まない部分置換の Edit は捕まらない**（[#1986](https://github.com/Dayopt/dayopt/issues/1986)）

**この経路は本節の変更が新設したものではない。** 以前の `.op-env.agent.example` は Supabase の接続情報を `op://agent/supabase/...`（実測で production と同一値）で持っており、何も書き足さずに同じ到達ができた。

**閉じない境界**（意図的に追わない。書かない境界は「閉じているはず」と誤読される方が危険なので明記する）:

- **実行時に文字列を組み立てる形** — 変数展開（`op run --env-$X=…`）、shell の escape 展開（`$'\x6c\x65'` / `$'\154\145'` のような ANSI-C escape）、base64、wrapper script を書いてそれを実行する。これは事故ではなく意図的な回避（`eval` とコマンド置換は、flag を言及するコマンドでは上記 2 が落とす）。

  **この集合は数え上げられない。** guard が見るのはコマンド文字列で、そこから shell の解釈を再現することはできない。静的に決まる quote 形式（`"` `'` `\`、`$'…'` / `$"…"` の literal）は正規化して追うが、**中身を展開しないと `--env-file` にならない形は追わない**。1 つ塞いでも同じ到達が別の形で作れる — 実測で、escape 展開を塞いでも `X=file; op run --env-$X=…` と wrapper script はどちらも通る。したがって escape 展開だけを塞ぐことに意味は無い。

  **ここから先の権威は 2 つ**。実行時の中身検査（上記 1）が、どの書き方で辿り着いても最後に実ファイルを読む。そして `AGENTS.md` §シンプルルール の `EXPLICIT AUTHORITY` と 1Password 側の承認が、production への操作そのものを止める。**hook はそこへ至る前のスピードバンプ**であって、意図的な回避の最終的な境界ではない。

- **inline env var 経由の `op://` 解決** — `VAR="op://…" op run -- <cmd>` の形は、env-file を経由しないため vault allowlist（env-file の中身検査）の対象外。`op run` は process env 中の参照も解決する。**これは意図的な受容**（機械で閉じるには hook がコマンド中の全 env 代入を解釈する必要があり、env-file 検査と同じ「regex で shell を再現できない」壁に当たる）。この形で human / ci を読むのは User の明示操作に限り、実効的な抑止は 1Password 側の承認プロンプトが担う。Service Account 導入の設計（[#2086](https://github.com/Dayopt/dayopt/issues/2086)）で機械的に閉じられるかを再訪する
- **hook の cwd と実行時の cwd がずれる場合** — 中身の検査は hook の cwd から path を解決する。コマンド自身が `cd` する形は上記 2 で落とすが、tool 側の cwd が hook と異なる環境では検査対象と実際のファイルがずれうる
- **tool 呼び出しをまたぐ書き換え** — 1 回目で書き、2 回目で消費する形は、2 回目の実行時検査が捕まえる（同一コマンド内は上記 2 が担当）

**hook はスピードバンプであって最終的な境界ではない**（`.husky/pre-push` と同じ位置づけ）。production への操作を止める本体は `AGENTS.md` §シンプルルール の `EXPLICIT AUTHORITY` と、1Password 側の承認。

**guard script 自体が壊れた時の挙動は決定済み（2026-08-13、User 決定。[#1961](https://github.com/Dayopt/dayopt/issues/1961)）。** bash は構文エラーでも `exit 2` を返すため、単一ファイル構成では guard が壊れると hook は全操作をブロックし、**guard を直す編集まで塞ぐ**（2026-08-12 に発生し、別セッションからの復旧が必要になった）。

採ったのは純粋な fail open でも fail closed 全面維持でもなく、**中間案**: 薄い loader `scripts/hooks/pre-tool-guard.mjs` と実ロジック `pre-tool-guard-rules.mjs` の 2 ファイルに分離する。loader は毎回 rules を `import()` し、成功したら委譲する（rules の判定は allow のみ 0、他はすべて 2 へ写す — 実行時エラーで例外を投げても fail closed を保つ）。import に失敗（構文エラー等）したら fail closed を既定にしつつ、**rules ファイル自身への Write/Edit だけ**を復旧目的で例外的に通す。他のすべての操作（Bash 全般、他ファイルの Write/Edit、spawn_task）は引き続きブロックする。当初は bash（`pre-tool-guard.sh` + `pre-tool-guard-impl.sh`、`bash -n` で構文検査）で実装し、2026-09-02 に他の L0 script と同じ Node へ移植した（挙動は同一、経緯は git 履歴）。

1 ファイル構成では、自己検査コードを含めファイル内のどのコードも構文エラーで実行されなくなるため（bash も Node の ESM も、ファイル全体をパースしてから実行する）、この中間案は loader/rules の 2 ファイル分離でのみ実装できる。fail open 全面採用は復旧経路以外の全保護（force-push・env-file 消費・spawn_task ブロック）まで無効化する過剰な倒し方であり、fail closed 全面維持は復旧に別セッションを要求し続ける。中間案は問題の scope（復旧経路が塞がること）と対応の scope を一致させる。契約は `scripts/__tests__/pre-tool-guard.test.ts` の「loader/rules 分離」describe が固定する。

**受け入れる誤検知**（fail closed の代償。どちらも回避策がある）:

- `-env-file` のあとに何か語や引用符が続く文字列は、Bash 引数に含めるだけで落ちる（引用符の中でも散文でも同じ。`rg -- '--env-file' scripts/hooks/` のような自己検索も含む）。docs や commit message にコマンド例を書く時は Write / Edit で file に書いてから `--body-file` / `-F` で渡す。名前を検索したいだけなら **leading dash を外す**（`rg env-file scripts/hooks/` は通る）
- `op run` の行に他のコマンドを繋げられない。雛形のコピーと実行を 1 行に畳む形（`cp .op-env.agent.example .op-env.agent && op run …`）、`cd` してからの実行、実行結果のリダイレクトによるログ取りが該当する。**分けて実行すれば通る**
- 単一コマンド判定は文字単位なので、**引用済み引数の中の区切り記号でも落ちる**（`op run --env-file=… -- node -e "console.log('a|b')"`）。この形は分けても回避できない。判定範囲を絞れるかは [#1987](https://github.com/Dayopt/dayopt/issues/1987) で検討する

**触らない（読みも書きもしない）**:

- `.env` / `.env.local` / `.env.*.local` / `.env.development` / `.env.staging` / `.env.production` / `.envrc` / `supabase/.env*` — 通常は存在しないが、`vercel env pull` などで一時的に実値入りで生成されうる。読むと実値が agent の会話ログに載り、方針 4「値を表示しない」に反する

secret の**利用**は制限しない。agent は `op run` 経由（`pnpm dev`、MCP の自己解決起動など）で値を見ずに secret を使う。これが 1Password 移行後の設計であり、実値ファイルを読める必要はない。

### API 経由の設定読戻し

上記はファイルの読み書きを対象とする。別経路として、設定系 API（Supabase Management API、Vercel Env API、Stripe API 等）の GET レスポンスに secret が同梱されるケースがある。**レスポンスをそのまま表示しない**。`jq` で必要フィールドだけに射影してから表示する（allowlist 方式）。`*_secret` / `*_key` / `*_token` / `*password*` を含むキーは射影に含めない。

このキー名パターンは secret を取りこぼさないための deny 規則であって、名前に反応しているだけなので偽陽性が出る。**値が credential になり得ない boolean / enum の policy flag に限り、キー名を 1 つずつ明示列挙する形で例外を認める**（例: `security_update_password_require_reauthentication` は `password` を含むが真偽値の設定フラグ）。パターン一致による一括許可と、射影に載せていないキーの値を出力することは引き続き禁止。

射影を書けない・レスポンス構造が不明な場合は、まずキー一覧だけを確認してから射影を組む。**素の `jq 'keys'` は使わない** — レスポンスが scalar（secret 文字列そのもの）だと `jq` がエラーメッセージに値を含めて stderr へ出す。type を先に判定する:

```bash
... | jq 'if type == "object" then keys else type end'
```

この節はここまで **Vercel Env API / Stripe API 等、下記の機械強制が及ばない API に対する規律**として維持する。

**Supabase Management API の `config/*` と `branches*` は、規律ではなく機械で閉じる（#2293）。** 2026-08-11 に denylist keyword フィルタと部分一致 keyword フィルタが 2 回とも漏れ（`db_pass` が `password` denylist を素通り、`security_captcha_secret` が `CAPTCHA` 部分一致に誤ヒット）、jq 射影の「形」を agent が都度書く運用そのものが再発を防げないと判明した。`scripts/hooks/pre-tool-guard-rules.mjs` が `curl` / `wget` によるこれらエンドポイントへの直接アクセスを **jq 射影の有無を問わず無条件で block** する（jq の形が正しい allowlist かどうかは regex では検証できないため。shell 展開回避と同型の壁）。安全な代替は `scripts/agent/supabase-mgmt-safe-get.mjs` に一本化する:

```bash
SUPABASE_ACCESS_TOKEN="op://human/supabase-cli/SUPABASE_ACCESS_TOKEN" \
  op run -- node scripts/agent/supabase-mgmt-safe-get.mjs auth-config security_captcha_enabled external_email_enabled disable_signup
```

field allowlist は `production-auth-config-audit.mjs` の `AUTH_CONFIG_CONTRACT` から派生し（二重管理を避ける）、`redact: 'url'` の付いた entry（`hook_send_email_uri`）は除外する。allowlist 外の field を 1 つでも含む要求は全体を拒否する（部分的に応じると allowlist 外の field を紛れ込ませて値を得られてしまうため）。`branches` については wrapper を作らず `supabase branches list`（既存 CLI、metadata のみ）へ誘導する — `branches get` が返す個別 credential に対して安全な部分集合が存在しないため。

**wrapper がカバーするのは `config/auth` の boolean / enum / secret になり得ない値だけ**（`AUTH_CONFIG_CONTRACT` の対象）。`config/database` 等、他の config sub-resource は wrapper 未対応で、curl 直叩きは無条件 block のまま代替経路が無い。必要になったら wrapper に subcommand を追加する（先回りして作らない、実際の需要が出てから拡張する）。それまでの間に必要が生じた場合は User の明示操作（Supabase Dashboard での確認）に委ねる。

### `op item get` / `op read` の直接実行（#2293）

**`op item get` は `--reveal` または `--format=json`（`OP_FORMAT=json` 含む）を伴うと block される。** 1Password CLI の実測: `--format=json` は `--reveal` の有無に関わらず concealed field の実値を `.value` へ含める仕様で、`--reveal` は human-readable テキスト出力の masking にのみ効く。既定の human-readable 形式・`--reveal` なしは値が masked のまま出るため、存在確認はこの形で行う（`op item get <itemName> --vault <vault> --fields <field>`。位置引数は itemName/itemID/shareLink のみで、vault は `--vault` flag で別途指定する — `<vault>/<item>` のような slash 結合形は `op item get` の構文には無い）。この block は orchestration.md §手作業コンシェルジュレーンの「item UUID / 名前の照合のみで行い、生 JSON を表示しない」idiom を機械強制する形になる。値そのものが必要な操作は既存の `scripts/admin-*.sh`（内部で `--reveal` を使うが agent の Bash tool には見えない実行経路）で行う。

**`op read op://...` の agent Bash tool からの直接実行は、`>/dev/null` への破棄 redirect の有無を問わず無条件で block される。** `op read` は常に実値を stdout へ出す（`--reveal` 相当の masking を持たない）コマンドで、当初は `>/dev/null` への破棄があれば許可する設計だったが、`2>/dev/null`（stderr のみの破棄で stdout は素通り）や複数出現時の判定漏れが push 前反証レビューで見つかり、例外を作らず無条件 block へ変更した。接続確認は `op item get <itemName> --vault <vault> --fields <field>` の既定 human-readable 形式（`--reveal` なし、上記参照）で代替する。値そのものが process 内で必要な操作（env-file 経由の `op run` 等）はこの block の対象外。

### `op item create` / `op item edit` の stdout 抑制

策定日: 2026-08-17（[#2086](https://github.com/Dayopt/dayopt/issues/2086) 残 scope、Main采配）。`op run` は stdout / stderr の secret masking が既定で有効だが、`op item create` / `op item edit` に実値をフィールド引数として直接渡す形（`'FIELD[concealed]=実値'`）は masking の対象外で、コマンドの引数そのものが agent の会話ログ・シェル履歴に残る（2026-08-14 に実際に発生した stdout 露出事故、mcp-usage.md 参照）。

**agent は `op item create` / `op item edit` の引数へ実値を直接埋め込んで実行しない。** 値の投入は 1Password GUI で行うか、値を含まないプレースホルダ（`FIELD[concealed]=`、本ページの `scripts/runbook/setup-1password.sh` が使う形）だけを扱う。実値を要する item 操作（値の新規投入・更新）は User が行う。

機械的な強制（pre-tool-guard-rules.mjs への正規表現追加）は見送る。`.op-env.human` の env-file ガードと同じ理由で「引数の形を数え上げると別の書き方で回り込まれる」壁に当たり、この事故は頻度・被害とも guard の複雑化に見合うほど大きくない。実インシデントが再発したら pre-tool-guard-rules.mjs 側の追加を再検討する。

---

## 保管対象

「API キー」「SSH 鍵」で分類すると漏れる。**漏れた時に何が起きるか** で分類する。

### ① API キー / アクセストークン

プログラム的アクセス権の鍵。Supabase service role、Stripe secret、Sentry auth token、Vercel token、GitHub PATなど。任意・legacyのprovider tokenも同じ分類で扱うが、runtime要件かどうかは`scripts/tasks/env/schema.ts`で判定する。

### ② SSH 鍵 / 署名鍵

- **SSH 秘密鍵**: GitHub push 権限そのもの
- **commit 署名鍵**: 検証済みコミットの信頼境界

SSH 秘密鍵は 1Password SSH Agent 管理を正とし、ローカル秘密鍵ファイルを増やさない。

### ③ DB 接続情報 / 接続文字列

Supabase DB password / pooler URL / 将来の Redis 等。接続文字列は user・password・host が一体化しやすいため、可能な限り field を分けて保管する。

### ④ OAuth / サービスアカウント

Google OAuth client secret、Apple Developer `.p8`、証明書、service account JSON など。ファイル形式のものは 1Password Document として保管する。

### ⑤ リカバリー系

再発行できないもの。各サービスの 2FA recovery codes、TOTP seed、ドメインレジストラ recovery 情報を含む。正本は各 Login item 側に置く。該当 item に 1Password タグ `recovery` を付け、横断確認は `op item list --tags recovery --format=json`（値は表示されない）で行う（2026-08-14、索引 secure note 方式から変更。索引 note は手動維持が必要で腐るため、item 側にコロケーションするタグ方式へ切り替えた。経緯は #2069）。**`op item list --tags recovery` の空リストは「recovery 情報が無い」ではなく「タグ未付与」の可能性を含む。** 既知の保持 item（`github-login` / `domain` / 各サービス Login item）と突き合わせて確認する。タグの命名規約・横断確認コマンドの一般形は次節「タグ体系」を参照（`recovery` はそちらが定める性質軸のトップレベルタグの 1 つ）。

---

## タグ体系

策定日: 2026-08-14（[#2077](https://github.com/Dayopt/dayopt/issues/2077)、User 承認。正本マッピングは同 issue の「正本マッピングの固定 + 適用状態の訂正」コメントを参照）

1Password のタグは vault（環境・権限軸）/ カテゴリ（保管対象の型軸、上記①〜⑤）と直交する第 3 の軸として、**ベンダー軸**（漏洩・乗っ取り・ベンダー exit 時に「このベンダーに紐づく item 一式」を横断列挙する）と**性質軸**（事業・個人領域を横断する重要度フラグ）の 2 種類を運用する。

### ベンダー軸: `dayopt/<vendor>`

- 形式は全小文字・ネスト（`dayopt/<vendor>`）。bare `dayopt` は使わない（親 `dayopt` はネスト包含で暗黙に一致するため、`dayopt` 単独のタグは冗長）
- **付与するのは次のいずれかに該当する item だけ**（全 item への一律付与はしない）:
  - (a) 同一ベンダーに紐づく item が複数ある（例: Cloudflare の Login + API token 等が分かれている場合）
  - (b) 製品名と事業者名が一致せず、タグが無いと同一ベンダーだと気づけない（例: Turnstile は Cloudflare の一機能なので `dayopt/cloudflare` 配下に含める）
- **単発ログインの長尾はグループタグへ畳む**。個別ベンダータグを作らず、性質が近い長尾をまとめる:
  - `dayopt/sns` ← X (Twitter) / Bluesky / Reddit / Instagram / TikTok
  - `dayopt/tools` ← Zed / GitKraken / Tailwind / Recraft AI / Sakana / Grok / OpenAI / ChatGPT
- **`dayopt/internal` は内部運用 item のグループタグ**（app / local / localhost / Dayopt）。外部ベンダーではなく自社の product/運用環境を指す item のため、ベンダー個別タグではなくこのグループへ畳む
- **階層は 2 段まで**（`dayopt/<vendor>` 止まり。3 段化は不採用）。中間カテゴリ層を挟むと分類論争と表記揺れを生みやすく、`op item list --tags dayopt` のような親指定で子タグ全体を包含できるため、3 段目を作る実益が無い
- **種別タグ（login / api 等）は作らない**。上記①〜⑤の保管対象カテゴリと役割が重複する
- 個人領域（会社契約でない個人アカウント）の item にはこのタグ体系を適用しない
- Freee は会計（事業基幹システム）のため、長尾グループへ畳まず `dayopt/freee` を単独維持する

正本マッピング（2026-08-14 時点）: `dayopt/<vendor>` = cloudflare / github / google / supabase / sentry / resend / stripe / vercel / upstash / slack / anthropic / uptimerobot / freee。`dayopt/internal` = app・local・localhost・Dayopt。`dayopt/sns` = X・Bluesky・Reddit・Instagram・TikTok。`dayopt/tools` = Zed・GitKraken・Tailwind・Recraft AI・Sakana・Grok・OpenAI・ChatGPT。

### 性質軸: トップレベルタグ

- `recovery` — 再発行不可の recovery 情報を持つ item（詳細は上記§⑤）
- `critical` — 定期監査の絞り込み対象にする重要 item（事業・個人領域を横断）

いずれも **`dayopt/` 配下にネストしない**トップレベルタグで、ベンダー軸と併用する（1 item に複数タグを付けてよい）。事業・個人領域を横断する性質軸のため、`dayopt` 配下（事業領域限定）に置くと個人 item に付けられなくなる。

### 横断確認コマンド

値を含まない一覧取得のみ。secret 本体を表示しないのは基本方針 4 と同じ。**検収は `--tags` フィルタではなく `op item list --format=json` の生タグ集計で行う**（`--tags` フィルタは実測でネスト状態の誤判定を起こした。2026-08-14、本節末尾「運用注意」参照）:

```bash
# 全 item のタグを集計し、目視で分類・重複を確認する
op item list --format=json | jq -r '.[] | .tags[]?' | sort | uniq -c | sort -rn

# 特定 item のタグだけを確認する
op item list --format=json | jq -r '.[] | select(.title == "<item名>") | .tags'
```

集計結果に無いタグは「未付与」、複数回同じタグが同一 item に出る場合は「重複汚染」（後述の運用注意を参照）。

### 運用注意

- **`op item edit --tags` はこの環境で置換ではなく和集合＋重複を作る**（2026-08-14 実測。ドキュメント上の仕様は全置換だが、実際には既存タグへ追記され、同一タグを繰り返し edit するたびにコピーが増える）。**タグ編集は 1Password アプリの GUI を正とし、`op item edit --tags` は使わない**
- **SSO field を持つ item は GUI 編集のみ**。例: Cloudflare は SSO 連携 item のため CLI からのタグ付けができない
- **SSH Key 型 item も同様に GUI 手動**（field 構成が Login item と異なり、CLI からのタグ編集が通らないケースがある）
- **日本語ロケールで作成した API Credential 型 item は標準 field id が `credential` になる**。他ロケール・他型との field 名の揺れに注意する

適用状況（2026-08-14 時点、詳細は #2077 のコメント履歴）: CLI で適用した item のうち一部（`domain` / `github-login` / `google` / `human` の `supabase` / `tailwind`）が上記の `op item edit --tags` 挙動により重複タグを持つ汚染状態にある。SSO / SSH Key 型の GUI 手動対象 15 件と合わせて、GUI での掃除待ち。この汚染は**読み取り専用の横断確認コマンドには影響しない**（`jq` 側で重複を検出できるため）。

---

## Vault / Item / Field Schema

field 名は可能な限り current code の env 名と一致させる。`.op-env.agent.example` はこの schema の参照だけを持つ。

以下は期待 schema で、`scripts/tasks/env/schema.ts` が正本。`pnpm 1password:check` が item / field の実在と empty 状態を値を表示せずに検証する。2026-08-11 に 1Password CLI で全 entry を実測し、schema と実態の乖離は [#1929](https://github.com/Dayopt/dayopt/issues/1929) / [#1930](https://github.com/Dayopt/dayopt/issues/1930) で解消した（旧記述が所有者としていた #1558 は closed のため、受け皿は #1930 が引き継いだ）。

vault は 2026-08-14 の信頼境界軸再編（[#2086](https://github.com/Dayopt/dayopt/issues/2086)、User 裁可）で **`agent` / `ci` / `human` の 3 箱**。軸は環境ではなく**読み手**（誰が読めるか）で、環境の区別は item 名（`stripe-test` / `stripe-live` 等）とタグ体系が担う。旧 vault との対応: `Dayopt-Staging` + `Dayopt-Shared` の AI 消費分 → `agent`、`Dayopt-Shared` の automation token → `ci`、`Dayopt-Production` + `Dayopt-Shared` の login / recovery / 個人系 → `human`。

### `agent`

**AI が `op run` で解決してよい credentials を全部ここに置く**（「入れた瞬間 AI に漏れたとみなしても困らないもの」だけを入れる）。pre-tool-guard の vault allowlist はこの 1 vault のみを通す。

**test mode credential と、local dev が使う app 設定が主な中身。** 通常の PR Preview では使わず、persistent staging を追加した時、または local dev 用の長寿命参照が必要な時だけ使う。

**常設 staging 環境は存在しない**（Supabase の branch は `main` のみ）。そのため Supabase の接続情報（`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_PASSWORD`）はこの vault に置かない。置けば production の複製にしかならず、実際 2026-08-11 まで 4 field とも `human/supabase` と同一値だった（[#1929](https://github.com/Dayopt/dayopt/issues/1929)）。local dev の Supabase 接続は `scripts/tasks/dev-with-op.sh` が `supabase status -o env` から注入し、1Password を経由しない。この境界は `scripts/__tests__/staging-supabase-boundary.test.ts` が固定する。

| Item              | Fields                                                                                                                                                                                                                                                                                                                                               | 用途                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `supabase`        | `CRON_SECRET`, `SEND_EMAIL_HOOK_SECRET`, `SENTRY_DSN`（Edge Function send-auth-email 用、任意）                                                                                                                                                                                                                                                      | staging 用 optional secret（cron / send-email hook の local dev 検証）                          |
| `upstash`         | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                                                                                                                                                                                                                 | Redis rate limit / cache                                                                        |
| `stripe-test`     | `STRIPE_SECRET_KEY`, `STRIPE_ACCOUNT_ID`, `STRIPE_LIVEMODE`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`                                                                                                                                                                                                                              | Stripe test mode                                                                                |
| `resend`          | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`                                                                                                                                                                                                                                                                                       | Production email sending master（旧 Shared から統合）+ optional staging の Product webhook 署名 |
| `app`             | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `RECOVERY_CODE_PEPPER`, `OAUTH_CLAUDE_REDIRECT_URIS`, `OAUTH_CHATGPT_REDIRECT_URIS`, `OAUTH_CURSOR_REDIRECT_URIS`, `MCP_OAUTH_ENVIRONMENT`, `OAUTH_AUTHORIZATION_SERVER_URI`, `MCP_CANONICAL_RESOURCE_URI`, `MCP_OAUTH_PREVIEW_BRANCH`, `MCP_OAUTH_PREVIEW_UPSTASH_HOST`, `MCP_WRITE_ENABLED_CLIENTS` | App URL / recovery code HMAC pepper / MCP OAuth beta                                            |
| `google-calendar` | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_PROJECT_NUMBER`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CALENDAR_REDIRECT_URIS`                                                                                                                                                                                     | 外部カレンダー取り込みの OAuth client（local dev 用）                                           |
| `turnstile`       | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                                                                                                                                                                                                                                                                                             | Cloudflare Turnstile（旧 Shared）                                                               |
| `anthropic`       | `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                                                                                                                  | optional / legacy key。現行 runtime consumer なし（旧 Shared）                                  |
| `google`          | `GOOGLE_SITE_VERIFICATION`, `YANDEX_VERIFICATION`, `YAHOO_VERIFICATION`                                                                                                                                                                                                                                                                              | Webmaster verification（旧 Shared）                                                             |
| `vercel`          | `VERCEL_TOKEN`（agent 用別発行、未発行 pending）                                                                                                                                                                                                                                                                                                     | `pnpm replica:check` 用。CI の token（ci/vercel）とは別発行で共用しない（#2086 plan v2）        |

`SUPABASE_ACCESS_TOKEN`（Supabase Management API 用。cloud の `supabase` MCP server と `scripts/runbook/enable-auth-hook.sh` が使う）は `human/supabase` を正本に一本化した（[#1933](https://github.com/Dayopt/dayopt/issues/1933)）。以前は `human/supabase` と同一値のまま `agent/supabase` にも複製されていたが、production を指す token を staging item から読む理由が無いため repo 側の参照はすべて production へ切り替えた。**item 自体は残す**（`CRON_SECRET` / `SEND_EMAIL_HOOK_SECRET` は cron / send-email hook の local dev 検証に使うため、廃止しない）。

**2026-08-17 に `human/supabase-cli` へ再移動した**（[#2127](https://github.com/Dayopt/dayopt/issues/2127)）。「アプリが env として消費する値の束」と「人間・CLI が使う operational credential（PAT / CLI token / rotation 対象、有効期限 field 必須）」を分離する命名規約に合わせ、`SUPABASE_ACCESS_TOKEN` は専用 item `human/supabase-cli` へ切り出した。`human/supabase` 側の同名 field は **削除済み**（2026-08-17、`op item get` で実測確認）。repo 側の参照はすべて `human/supabase-cli` を正本とする。

同じ整理で `human/upstash-legacy`（schema 未参照、値未登録の残骸）・`human/resend-old-staging`（`resend` / `resend-web` と同一 field 構成の古い複製）の 2 件を archive した（1Password 側は削除ではなく Archive、復元可能）。`human/supabase-legacy` は #2127 着手前に User が削除済みだったことを実測で確認した。`human/upstash-login` は `human/supabase-login` と同型の Upstash Console GUI ログインと判定し、残置のうえ台帳化した。実施記録は [#2127 コメント](https://github.com/Dayopt/dayopt/issues/2127#issuecomment-5312176560)を参照。

`google-calendar` item は 2026-08-14 実測時点で **1Password に存在しない**（#2063）。`.op-env.agent.example` の該当行はコメントアウト済みで、`pnpm dev` の正規ルートはブロックされない。外部カレンダー連携を local dev で検証するには、test mode の Google OAuth client を作成した上で item を作る必要がある（User 手作業）。

### `human`

**人間だけが読む box。AI が消費する経路を作らない**（`.op-env.human` の読み書きは #1993 どおり可、消費だけが gate。参照の解決は User の明示操作に限る）（[#2086](https://github.com/Dayopt/dayopt/issues/2086)。ただし desktop 統合経由の到達は承認プロンプト gated であり、機械的遮断は Service Account 導入後）。本番 secret（旧 Dayopt-Production 全部）と、login / SSH / recovery / 個人系（旧 Dayopt-Shared から移動）を置く。

本番 secret は通常ローカルから参照せず、Vercel / Supabase Dashboard へ replica として同期する。Sentry は Product / Web で project を分離するため、metadata / DSN の item も分ける。

| Item                     | Fields                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase`               | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`, `CRON_SECRET`, `SEND_EMAIL_HOOK_SECRET`（`SUPABASE_ACCESS_TOKEN` は `supabase-cli` へ切り出し済み。同名 field は削除済み）                                          |
| `supabase-cli`           | `SUPABASE_ACCESS_TOKEN` + 有効期限 field。CLI / MCP が使う operational credential 専用 item（rotation 対象、#2127）                                                                                                                                                                    |
| `supabase-login`         | Supabase Dashboard の GUI ログイン（LOGIN item、OTP 付き）。op:// では参照されない、ブラウザでの手動サインイン専用（#2127）                                                                                                                                                            |
| `upstash`                | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                                                                                                                                                   |
| `upstash-login`          | Upstash Console の GUI ログイン（LOGIN item）。op:// では参照されない、ブラウザでの手動サインイン専用（#2127）                                                                                                                                                                         |
| `stripe-live`            | `STRIPE_SECRET_KEY`, `STRIPE_ACCOUNT_ID`, `STRIPE_LIVEMODE`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`                                                                                                                                                                |
| `resend`                 | `RESEND_WEBHOOK_SECRET`（Product）                                                                                                                                                                                                                                                     |
| `resend-web`             | `RESEND_WEBHOOK_SECRET`（Web、Productと別値）                                                                                                                                                                                                                                          |
| `sentry`                 | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`（Product）                                                                                                                                                                                                      |
| `sentry-web`             | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`（Web）                                                                                                                                                                                                          |
| `app`                    | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `RECOVERY_CODE_PEPPER`, `OAUTH_CLAUDE_REDIRECT_URIS`, `OAUTH_CHATGPT_REDIRECT_URIS`, `OAUTH_CURSOR_REDIRECT_URIS`, `MCP_OAUTH_ENVIRONMENT`, `OAUTH_AUTHORIZATION_SERVER_URI`, `MCP_CANONICAL_RESOURCE_URI`, `MCP_WRITE_ENABLED_CLIENTS` |
| `google-calendar`        | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_PROJECT_NUMBER`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CALENDAR_REDIRECT_URIS`                                                                                                                       |
| `google-auth`            | `SUPABASE_AUTH_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_GOOGLE_SECRET`                                                                                                                                                                                                                        |
| `sentry-login`           | `SENTRY_AUTH_TOKEN` + account login（旧 Shared）                                                                                                                                                                                                                                       |
| `github-login`           | password, TOTP, recovery codes（旧 Shared）                                                                                                                                                                                                                                            |
| `github-ssh`             | SSH private key（旧 Shared）                                                                                                                                                                                                                                                           |
| `domain`                 | registrar login, TOTP, recovery codes（旧 Shared）                                                                                                                                                                                                                                     |
| `resend-support-replies` | `RESEND_SMTP_API_KEY`。Gmail Send mail as 専用（旧 Shared）                                                                                                                                                                                                                            |

`google-auth` は Supabase Auth の Google provider（ソーシャルログイン）用。**アプリの env には入らず、Supabase Dashboard だけが replica** になる（Dashboard Secrets 節を参照）。GCP project は `dayopt`（`dayopt-503623`）、client 名は `Dayopt Auth (Supabase)`、redirect URI は `https://yvglwblxrnrenfifsnje.supabase.co/auth/v1/callback` の 1 本だけ。

`google-calendar` は外部カレンダー取り込み（[#1702](https://github.com/Dayopt/dayopt/issues/1702)）専用の OAuth client で、Supabase Auth の Google provider とは別 client として作る。Supabase 側の client secret を流用しない。`GOOGLE_CALENDAR_PROJECT_NUMBER` は client ID の先頭にある project number と一致させる。

- `OAUTH_CLAUDE_REDIRECT_URIS` / `OAUTH_CHATGPT_REDIRECT_URIS` / `OAUTH_CURSOR_REDIRECT_URIS` はclientが発行する追加callback URIのcomma区切りexact allowlist。wildcardやoriginだけの緩い一致は使わない。既定callbackで足りるclientではfieldを空のままにする
- `MCP_OAUTH_ENVIRONMENT`はOAuth identityの環境marker。所有する環境はProductionと一時Previewの2つだけで、常設Stagingは作らない。一時Previewでは`preview`を必須とし、`VERCEL_ENV=preview`、`VERCEL_TARGET_ENV=preview`、branch、issuer、resourceのどれかが一致しなければbuildとruntimeを停止する。Productionは未設定時だけ既存originを既定値にする
- `OAUTH_AUTHORIZATION_SERVER_URI`と`MCP_CANONICAL_RESOURCE_URI`は環境ごとに固定するorigin。一時Previewでは同じstable branch URLを使い、transport path、query、fragment、Production originを含めない
- `MCP_OAUTH_PREVIEW_BRANCH`は検証対象PRのexact branch名。`VERCEL_GIT_COMMIT_REF`と一致しないPreviewを停止する。Productionには登録しない
- `MCP_OAUTH_PREVIEW_UPSTASH_HOST`は一時Preview専用Upstashのhost marker。接続先URLのhostと一致しないbuildを停止する。Productionには登録せず、ProductionのUpstashをPreviewへ複製しない
- `MCP_WRITE_ENABLED_CLIENTS`はruntime discovery/preflight用のclosed-beta allowlistであり、DBのglobal/client/connection gateを代替しない。未承認環境では空のままにする

- `CALENDAR_TOKEN_ENCRYPTION_KEY` は保存する refresh token を AES-256-GCM で暗号化する鍵。base64 で 32 バイトに decode できる値だけを受け付ける（`openssl rand -base64 32`）。鍵を失うと既存接続の token は復号できず、全ユーザーが再接続になる
- `GOOGLE_CALENDAR_REDIRECT_URIS` は comma 区切りの allowlist。callback は request host を allowlist と完全一致で引き、一致した文字列をそのまま Google へ渡す。Production には production origin だけを入れ、localhost を混ぜない（forwarded host 経由で allowlist を通過されうる）
- `STRIPE_ACCOUNT_ID` と `STRIPE_LIVEMODE` は、正しいStripe accountとmodeだけを変更するための固定identity。durable Billing / account deletionを有効にする前に、`STRIPE_SECRET_KEY` と3項目をまとめて設定する。test modeは `false`、live modeは `true`
- Preview は登録しない。ephemeral hostname は Google 側に事前登録できず、`__Host-` cookie も host 固定のため、Preview では接続開始時に明示エラーを返す

### `ci`

**CI が消費する値の master を置く。** 現在 CI は 1Password を直接読まず GitHub Secrets replica で動くため、この vault の読み手は同期作業の人間だけ。Service Account を導入する時は、この vault を SA の read scope にする（[#2086](https://github.com/Dayopt/dayopt/issues/2086)）。

| Item                         | Fields                                                                                        | 用途                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel`                     | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID_STAGING`, `VERCEL_PROJECT_ID_PRODUCTION` | Production Config Audit / Production Release / project metadata                                                                                                                                                                                                      |
| `supabase-auth-audit`        | `credential`                                                                                  | Production Auth Config Audit 専用 scoped token（Auth の Read のみ）                                                                                                                                                                                                  |
| `supabase-storage-rls-audit` | `credential`                                                                                  | Production Storage RLS Audit 専用 scoped token（`database_read` のみ、90 日期限）。`production-config-audit.yml` の `storage-rls` job が参照し、GitHub Secret `SUPABASE_STORAGE_RLS_AUDIT_TOKEN` へ同期する（[#2345](https://github.com/Dayopt/dayopt/issues/2345)） |

**Supabase Management API の scoped access token（`sbp_` prefix）は Account Settings → Access Tokens（https://supabase.com/dashboard/account/tokens）で発行する。** Project の Settings → API Keys ページ（`sb_sec...` prefix、Data API 用の secret key）とは別物で Management API には使えない。2026-08-25、`supabase-storage-rls-audit` token の発行でこの取り違えにより 401 が発生した（[#2345](https://github.com/Dayopt/dayopt/issues/2345) コメント参照）。

予定（#2090 の実施後に追加する）: `VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB`（bypass secret の 1Password 登録先）。

`VERCEL_TOKEN`はautomation専用とし、local CLIのloginや`--token`引数には使わない。Production Config AuditとProduction Releaseが環境変数からprocess内で読み、Authorization headerにだけ設定する。Production Releaseはenv metadataの読取に加えて、Production deploymentのpromoteとrollbackを行う。localの確認方法とrotation順序は[Environment Secrets](./security/environment-secrets.md)を正とする。agent からは読まない（agent の `replica:check` は agent 用の別発行 token を使う。発行までは User 実行）。

---

## Service Account（無人実行用、設計のみ・未導入）

策定日: 2026-08-17（[#2086](https://github.com/Dayopt/dayopt/issues/2086) 残 scope、User 裁可）。**本節は設計の記録であり、実装は未着手**。1Password 側の Service Account 作成・token 発行は 1Password への実操作を伴うため、このレーンの PR には含めない（merge 後に手作業レーンへ振る）。

**ただしこの「手作業レーンへ振る」は現時点でプラン制約により保留**（2026-08-17 実測確認）。1Password の Service Account は Business / Teams プラン限定で、現行の Family プランでは作成できない。再検討トリガーはプラン変更（Business/Teams への移行）。

**目的**: 夜間自律実行・cron のような無人実行が、人間の 1Password desktop 統合セッションの承認プロンプトを介さずに `op run` を通すための経路。対話的セッション（現行の desktop 統合）はこの節の対象外で、変更しない。

**scope（決定）**: **`agent` vault の read-only のみ**。`human` / `ci` への到達権限は持たせない。これは pre-tool-guard-rules.mjs が消費側で強制している vault allowlist（`agent` のみ通す、上記「AI エージェントの env ファイル境界」節）と同じ境界を、1Password 側の権限設定でも二重に持つ形になる。

**認証方式**: `OP_SERVICE_ACCOUNT_TOKEN` 環境変数を設定したプロセスでは `op` CLI が Service Account モードで動作し、desktop 統合を経由しない。SA token が `agent` vault read-only にしか scope されていなければ、そのプロセスから `human` / `ci` を参照する `op://` は 1Password サーバー側で拒否される（hook の正規表現マッチではなく、1Password 自体の権限モデルによる拒否）。

**SA token 自体の保管（循環問題）**: SA token は「1Password を読むための鍵」なので、1Password 自身には保管できない。導入時点で **bootstrap 例外台帳の初件**になる（下記「Bootstrap 例外台帳」を参照）。保管場所（OS keychain、GitHub Secrets、その他）は導入時に手作業レーンが決定する。

**inline `op://` 経路への効果（上記「AI エージェントの env ファイル境界」§閉じない境界 の再訪）**: 無人実行コンテキストに限り、SA が `human` / `ci` への読み取り権限を持たないため、env-file を経由しない `VAR="op://human/…" op run` のような inline 参照も構造的に失敗する。**対話的 desktop 統合セッションでは変更なし**（1Password 側の承認プロンプトが引き続き実効的な抑止点）。

---

## Local Dev

ローカル開発の正規ルートは `.op-env.agent` + `op run`。

```bash
cp .op-env.agent.example .op-env.agent
pnpm dev
```

`pnpm dev` は `.op-env.agent` の存在を確認し、`.env.local` / `apps/product/.env.local` / `apps/web/.env.local` が残っている場合は fail する。通常は Supabase local を参照し、停止中なら自動起動してから `supabase status -o env` の結果を URL / key として値表示なしで注入する。

**Supabase の接続先を 1Password 参照へ切り替える手段は無い。** かつての `DAYOPT_SUPABASE_TARGET=op` は `agent/supabase` の接続情報を使う escape hatch だったが、その中身が production だったため廃止した（[#1929](https://github.com/Dayopt/dayopt/issues/1929)）。設定しても `pnpm dev` は起動せずエラーで止まる。Supabase local が上がらない時は Docker Desktop を確認し `supabase start` を手動実行する。素の起動が必要な一時作業だけ `pnpm dev:raw` を使う。

**`.op-env.agent.example` から参照を消しても、各自の `.op-env.agent` は自動では追従しない。** `op run` は解決できない `op://` 参照があると起動前に失敗するため、1Password 側の field を削除したら `.op-env.agent` の該当行も消す必要がある。`cp .op-env.agent.example .op-env.agent` で作り直すのが確実。

### 管理者運用の env（`.op-env.human`）

`scripts/admin-*.sh` / `verify-login.sh` / `USE_LINKED_DB=true` の `seed-dev-data.sh` は Supabase Auth Admin API を service role で叩くため、Supabase の接続情報を必要とする。これらは `.op-env.agent` ではなく **`.op-env.human`**（`.op-env.human.example` から作る、gitignore 済み）を使う。

```bash
cp .op-env.human.example .op-env.human
op run --env-file=.op-env.human -- env USER_EMAIL=foo@example.com bash scripts/runbook/admin-show-user.sh
```

参照先は `human/supabase` で、**実行は production への操作になる**。分けている理由は 2 つ。第一に、通常の `pnpm dev` に production の service role key を混ぜないこと。第二に、env-file 名と参照先 vault の両方が production だと明示され、「staging のつもりで production を触る」が起きないこと。手順と作業ログの規約は [tooling.md 第4部](./tooling.md) を正本とする。用が済んだら `.op-env.human` は削除する（gitignore 済みで残しても secret は含まないが、消費だけが hook でブロックされる設計なので、残置は次に触る人の判断を増やすだけで益がない）。

雛形は接続 3 field に加えて `SUPABASE_DB_PASSWORD` を持つ。`USE_LINKED_DB=true` の `seed-dev-data.sh` が最後に `supabase db query --linked` を実行するためで、**欠けると Auth API での user 作成だけ成功して DB 投入で止まり、既知 password の user が production に残る**（部分適用）。同じ理由で `human/supabase/SUPABASE_DB_PASSWORD` は `required` にしてある。

Sentry runtime と source map upload は Production 限定のため、local の `.op-env.agent`、GitHub Actions、Vercel Preview / Development に Sentry env を複製しない。Vercel の `product` と `web` は同じ標準 env 名を使い、それぞれ `human/sentry` と `human/sentry-web` の値を Production target だけへ同期する。`SENTRY_AUTH_TOKEN` は `human/sentry-login` の単一 fieldをmasterとし、両projectのProduction targetへSensitive replicaとして同期する。

`.op-env.agent` には `op://` 参照だけを書く。実値、dummy secret、placeholder secret は書かない。

---

## Verification

検証コマンドは `scripts/tasks/env/schema.ts` の schema を参照する。いずれも secret 値、prefix、suffix、長さ、hash は表示しない。

```bash
pnpm env:check
pnpm secrets:check
pnpm 1password:check
pnpm replica:check   # 要 VERCEL_TOKEN / VERCEL_TEAM_ID（下記）
```

- `env:check` — required env を `OK / EMPTY / MISSING` だけで確認する
- `secrets:check` — tracked files と untracked `.env*` を scan し、literal secret は `value: [redacted]` で報告する。CI では ready 後の PR で走る（`ci.yml` の static job、`scripts/ci/check.mjs`。#2483 で docs-guard.yml から移設）
- `replica:check` — Vercel Production Env（product / web）の **key 名だけ**を取得し、1Password 台帳（`scripts/tasks/env/schema.ts` の `onePasswordEnvSchema`）に無い key を検出する（replica ⊆ 台帳。基本方針 7 の機械検証、[#2084](https://github.com/Dayopt/dayopt/issues/2084)）。`production-config-audit.mjs` が「台帳側の必須 key が Vercel に揃っているか」を見るのと逆方向。値は取得も表示もしない。**日次 cron（`.github/workflows/nightly.yml` の replica-check job、06:30 JST。#2483 で replica-check.yml から統合）で定期実行する**（[#2111](https://github.com/Dayopt/dayopt/issues/2111)。初回実運用の NG 13 件分類が #2094/#2101 の merge で完了したため、local 専用だった制約は解除した）。token は production-config-audit と同じ GitHub Secrets（`ci/vercel` の replica）を再利用し、新規 token 発行は不要。手元での単発実行も引き続き可能（下の実行例は `ci` vault を inline 参照で解決するため、agent はコピペ実行しない。agent 用 token（`agent/vercel`、発行待ち）が入ったら agent も自走できる）。実行例:

  ```bash
  VERCEL_TOKEN="op://ci/vercel/VERCEL_TOKEN" VERCEL_TEAM_ID="op://ci/vercel/VERCEL_TEAM_ID" op run -- pnpm replica:check
  ```

  検出された key の対応は 2 択: master（1Password）へ登録して schema に entry を足すか、Vercel 側から撤去する。台帳に無いが存在してよい key は script 内 `allowedNonLedgerKeys` に理由付きで載せる（空が正常。ただし Supabase↔Vercel integration 由来の 11 件は構造的に台帳登録できないため例外として載せている。詳細は下記 §Vercel Production の integration-managed 例外）。契約は `scripts/__tests__/check-vercel-replica.test.ts` が固定する

secret scan は 2 本立てで、担当範囲が違う。gitleaks は「この PR で新しく入った commit 範囲」だけを見る（全履歴には削除済みプレースホルダ由来の既知ノイズが積もっており、毎回 re-flag すると gate として機能しなくなるため）。`secrets:check` は「現在の tracked tree 全体」を見る。片方だけでは、既に main に入っている literal が誰にも検出されない。

- `1password:check` — 1Password の vault / item / field / empty 状態だけを確認する。schemaで`required: true`のentryまたはoperational itemが不足・空の場合だけ失敗し、optional entryは不足・空の状態を表示しても成功する。item の作成・変更・削除はしない
- `1password:check` は **禁止 field の実在**も検査する（`scripts/tasks/env/schema.ts` の `forbiddenFields`）。schema から entry を消すのは「参照しない」宣言でしかなく、実 vault に field が残っていれば依然として取得できてしまう。`agent/supabase` の接続 4 field と `SUPABASE_ACCESS_TOKEN`（production 正本への一本化後、#1933）はここに登録してあり、残っていれば `FORBIDDEN_PRESENT` で失敗する。`SUPABASE_ACCESS_TOKEN` field の実削除（1Password 側、User 手作業）が済むまで `1password:check` は意図どおり red になる（fail-closed。接続 4 field の時と同型）

この検査の**保証境界**は「正常応答から不在を確認できた時だけ `ABSENT` にする」。`op` の応答は vault / item / field の 3 段しかなく、そのどこで確認不能になっても `UNVERIFIABLE` として失敗させる。`op item get` は item 不在・権限エラー・一時エラー・不正 JSON をすべて同じ非ゼロ終了に畳むため、取得失敗を不在の証拠に使えないのが理由。3 段すべてを塞いだので「確認できないまま pass する」経路はこの検査には残らない。

この境界の帰結として、`forbiddenFields` に登録した item は実在し続ける必要がある。item ごと廃止する時は `forbiddenFields` の該当 entry も同時に外す。`agent/supabase` は [#1933](https://github.com/Dayopt/dayopt/issues/1933) で検討したが、`CRON_SECRET` / `SEND_EMAIL_HOOK_SECRET` が local dev 検証に使われているため item ごとの廃止はしない（`SUPABASE_ACCESS_TOKEN` だけを production へ一本化した）。

`.op-env.agent.example` の `op://` 参照は正規の local injection schema なので leak として扱わない。

### `1password:check` が失敗した時

失敗は「master に無い」ことしか意味しない。**schema を緩めて黙らせる前に、その env を誰が必要としているかを先に確かめる。** 判定は 2 通りに分かれる。

- **本当の欠落** — code が実際に要求している。replica（Vercel Production Env / Supabase Dashboard）には値があり、master だけが無い。この場合は replica から master へ値を戻す。§Change Procedure の逆流だが、master 不在の是正としては正しい向き。`required` は維持する
- **schema の乖離** — 機能が未有効などで item / field が無いのが正しい。この場合は `scripts/tasks/env/schema.ts` を `required: false` にする

「code が要求しているか」は build gate が正本になる。Sentry の 4 env（`NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` / `SENTRY_ORG` / `SENTRY_PROJECT`）は `packages/observability/build-gate.mjs` が product / web 双方の Vercel Production build で必須にしているため、`human/sentry` と `human/sentry-web` は両方とも実在が要る。

master へ値を戻す時は GUI か対象を限定した `op item create` / `op item edit` を使う。`scripts/runbook/setup-1password.sh` は 3 vault が空の時だけの初回 bootstrap 専用で、既存 vault には使わない。`recovery` タグの付いた item のような再発行できない情報を扱う item では、**既存情報の集約だけを行い、値の生成・再発行はしない**。

---

## External Replicas

### Replica 台帳（実値が 1Password の外に存在する場所）

策定日: 2026-08-14（[#2086](https://github.com/Dayopt/dayopt/issues/2086) やること 3 の初版）

基本方針 7「値がどこに存在していようと、必ず 1Password にもある」を検査可能にするための列挙。**この表に載っていない場所に長寿命の実値が存在したら、それ自体が違反**（発見したら master へ登録するか撤去し、この表を更新する）。

| 場所                                         | master                                                                                                                      | 機械検証                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel Production Env（product / web）       | `scripts/tasks/env/schema.ts` の各 entry                                                                                    | `production-config-audit.mjs`（台帳 → replica）+ `pnpm replica:check`（replica → 台帳、§Verification）                                     |
| Vercel Preview Env（`RECOVERY_CODE_PEPPER`） | `agent` / `human` の `app`（Preview 維持の経緯は [Environment Secrets](./security/environment-secrets.md) §Vercel）         | 無し                                                                                                                                       |
| GitHub Secrets                               | 各 entry（[Environment Secrets](./security/environment-secrets.md) §GitHub の表と 1:1。2026-08-14 に未参照 6 件を削除済み） | 無し（残る機械検証の設計は [#2090](https://github.com/Dayopt/dayopt/issues/2090) / [#2084](https://github.com/Dayopt/dayopt/issues/2084)） |
| Supabase Dashboard Secrets                   | `agent/turnstile` 等（下記 §Supabase Dashboard Secrets）                                                                    | 無し                                                                                                                                       |
| PR Preview Branch credentials                | 1Password 非保存（基本方針の既知の例外。ephemeral）                                                                         | —                                                                                                                                          |

**未台帳（invariant 違反候補、2026-08-14 実測）**: `VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB` は GitHub Secrets と Vercel（Protection Bypass for Automation）に存在するが、`ci/vercel` item（旧 Dayopt-Shared/vercel）に対応 field が無い（field label のみ実測、値は未取得）。処遇（1Password への登録、または再生成して登録）は [#2090](https://github.com/Dayopt/dayopt/issues/2090) の判断リストで扱う。

### Bootstrap 例外台帳

策定日: 2026-08-17（[#2086](https://github.com/Dayopt/dayopt/issues/2086) 残 scope）。上記の Replica 台帳が「master は 1Password、replica は外部」の対応を列挙するのに対し、こちらは **1Password の外に構造的に実値が存在する場所**（1Password へ登録すること自体ができない値）を列挙する。基本方針 7「値がどこに存在していようと、必ず 1Password にもある」の唯一の意図的な例外群。

**現在 0 件。** 調査の結果、既存の GitHub Secrets 6 件（`SUPABASE_AUTH_AUDIT_TOKEN` / `SUPABASE_STORAGE_RLS_AUDIT_TOKEN`（[#2345](https://github.com/Dayopt/dayopt/issues/2345) で発行・GitHub Secret 登録済み）/ `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB`）はいずれも 1Password `ci` vault を master に持つ replica であり、真の bootstrap 例外には該当しない（[Environment Secrets](./security/environment-secrets.md) §GitHub の表と 1:1）。

上記「Service Account（無人実行用、設計のみ・未導入）」の SA token が導入されれば、それが最初の例外になる（SA token は「1Password を読むための鍵」であるため、循環問題により 1Password 自身には保管できない）。保管場所は導入時に決定し、その時点でこの台帳に追記する。

### Vercel Production の integration-managed 例外

策定日: 2026-08-17（[#2084](https://github.com/Dayopt/dayopt/issues/2084) 初回実運用で検出した NG 13 件の分類、[#2094](https://github.com/Dayopt/dayopt/issues/2094)）

`pnpm replica:check` は product project の Vercel Production で 13 件の未台帳 key を検出した。Vercel API の `configurationId` で由来を確認したところ、issue の当初想定（13 件すべて integration 注入）とは異なり 2 群に分かれた:

- **integration 注入（11 件）**: `POSTGRES_DATABASE` / `POSTGRES_HOST` / `POSTGRES_PASSWORD` / `POSTGRES_PRISMA_URL` / `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` / `POSTGRES_USER` / `SUPABASE_JWT_SECRET` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。Supabase↔Vercel Marketplace integration（configurationId `icfg_ZZhIJpCa3ksZJLqBXjg257gb`、slug: `supabase`）が Production へ自動注入する固定セットで、Supabase 公式仕様上 per-key の選択的無効化はできない（all-or-nothing）。同じ integration が Preview の PR Preview Branch credentials 注入（本節上部の Vercel Preview 記述）も担うため integration 自体の切断もできない。アプリコードからの参照は 0 件（`rg` で production runtime / build-gate / env.ts を確認）。**master は integration 自身とし、1Password には登録しない**。`scripts/tasks/env/check-vercel-replica.ts` の `allowedNonLedgerKeys` に理由付きで台帳化済み
- **手動残骸（2 件、削除済み）**: `SUPABASE_URL` / `SUPABASE_ANON_KEY`。`configurationId` が無く、257 日前に手動作成された stray entry と判明（integration の 11 件は 73 日前）。既に台帳化済みの `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`（human/supabase）と意味的に重複し、アプリコードからの参照も 0 件だったため、2026-08-17 に Vercel Production から削除済み（User 裁可、Main実行）
  - **追記（2026-08-31、[#2458](https://github.com/Dayopt/dayopt/issues/2458)）: `SUPABASE_ANON_KEY` は削除の 1 週間後に integration が再注入した。** `replica:check` の再 NG を受けて `configurationId` を実測したところ、上の 11 件と同じ `icfg_ZZhIJpCa3ksZJLqBXjg257gb` で、`createdAt` は 2026-08-24（11 件は 2026-06-04）。つまり Supabase 側の注入セットが 12 件へ増えた。削除しても戻るため、手動残骸の扱いをやめて `allowedNonLedgerKeys` へ移した。**master は integration 自身で、1Password には登録しない**（台帳には `NEXT_PUBLIC_SUPABASE_ANON_KEY` が human/supabase として既に存在し、二重 master を作らないため）。`SUPABASE_URL` は再注入されていない（2026-08-31 時点の production target に不在）
  - integration 管理下の変数は **Vercel Dashboard の project env 一覧に現れない**（2026-08-31 実測。検索しても出ない）。由来の確認は `configurationId` を返す API でしか行えない: `curl -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v10/projects/product/env?teamId=$VERCEL_TEAM_ID"` を `jq` で `key` / `type` / `configurationId` / `createdAt` に射影する（値は射影しない）

**preview target には同名 `SUPABASE_URL` / `SUPABASE_ANON_KEY` が integration 注入として存在し続ける**（`configurationId` 一致で確認）。production target の手動残骸を削除しただけで、preview 側の integration 注入分は対象外・維持。`replica:check` は production target だけを見る設計のため影響しない。

### #2517 のコード移行契約

上の integration-managed 分類は当時の記録。#2517 では `SUPABASE_SECRET_KEY` と `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を runtime が使用するため、Production 台帳へ移し、未台帳例外から外す。実値の所有関係・同期確認はまだ完了を主張しない。Preview の integration 管理は維持する。配備前条件とrollbackは [Supabase API keys の移行](./supabase-api-keys.md) を参照。

### Vercel Env

Vercel Production Env は runtime / build 用の replica。1Password を先に更新し、必要な値だけ Vercel Dashboard に手動同期する。Vercel 側で値を直接変更した場合は、必ず同じ変更を 1Password master に戻す。

Vercel Preview の Supabase env vars は Supabase Vercel integration が PR Preview Branch credentials を注入する。Preview scope に production Supabase credentials を手動設定しない。

Contact送信用の`RESEND_API_KEY` / `RESEND_FROM_EMAIL`とapp別`RESEND_WEBHOOK_SECRET`はProduct / WebのProductionだけへ同期する。送信credentialはPreview / Developmentへ置かない。Vercel metadataは`scripts/ci/production-config-audit.mjs`でkey / target / typeだけを確認する。

旧`GITHUB_TOKEN` / `GITHUB_CONTACT_REPO`のVercel replicaは削除済みで、専用PATも失効済みである。current schemaの新規作成対象から外し、`Production Config Audit`が再設定を常時拒否する。経緯は[問い合わせメール運用](./contact-email.md)を参照する。

### GitHub Secrets

GitHub Actions Secrets は CI/CD 用の replica。build / e2e 用 public env などは 1Password から手動同期する。Migration は Supabase GitHub integration が担当するため、GitHub Actions から `supabase db push` しない。

### Supabase Dashboard Secrets

Supabase Auth Bot Protection、Auth hooks、Edge Functions、Vault secrets は Supabase Dashboard 側の replica。Turnstile secret などは 1Password から値をコピーし、Dashboard 側だけで変更しない。PR Preview Branch credentials は Supabase が短命に発行するため 1Password 管理外。

`SENTRY_DSN`（Edge Function `send-auth-email` 用、任意）も同じ replica 経路。Edge Function secret として未投入の状態が既定で、その場合 Sentry capture は no-op になる（#2682）。

production の Auth `uri_allow_list` に **localhost を入れない**。かつて `http://localhost:3000/**` が入っていたのは、local dev から production Supabase へ繋ぐ escape hatch（`DAYOPT_SUPABASE_TARGET=op`）が `window.location.origin` を `redirectTo` に渡していたためで、その hatch を廃止した今は依存する経路が無い（[#1929](https://github.com/Dayopt/dayopt/issues/1929)。local dev の redirect は `supabase/config.toml` の local 設定、Preview は ephemeral Preview Branch がそれぞれ持つ）。

---

## Change Procedure

1. 1Password master の該当 item / field を更新する
2. 必要な長寿命 replica（Vercel Production Env / GitHub Secrets / Supabase Dashboard）へ同期する
3. `op item get` や `op run` で **値を表示せず** 存在確認する
4. 旧 key がある場合は発行元サービスで revoke する
5. 変更内容は docs / PR には field 名と同期先だけを書く

`scripts/runbook/setup-1password.sh`は3 vaultが空の時だけ使う初回bootstrap専用。既存vaultへ新しいitem / fieldを追加する時はGUIまたは対象を限定した`op item create` / `op item edit`でmasterを先に更新し、`pnpm 1password:check`で値を表示せず検証してからreplicaへ同期する。

存在確認の例（agent の Bash tool 経由では `op item get` の既定 human-readable 形式・`--reveal` なしを使う。`op read` は #2293 により agent からの直接実行を無条件で block しているため、この用途には使わない。位置引数は item 名のみで、vault は `--vault` flag で指定する）:

```bash
op item get supabase --vault human --fields SUPABASE_SECRET_KEY
```

### 短命トークンのローテーション（expiry 付き再発行）

策定日: 2026-08-17（[#2112](https://github.com/Dayopt/dayopt/issues/2112)、User 裁可。epic [#2091](https://github.com/Dayopt/dayopt/issues/2091) 残課題「短命トークン手順の文書化」の初事例。2026-08-17 に [#2126](https://github.com/Dayopt/dayopt/issues/2126) で scoped token 前提へ改訂）。**本節は手順の記録であり、実操作は含まない**（発行・1Password 更新・revoke はすべて 1Password / 外部サービスへの書き込みを伴うため User + 手作業レーンが行う）。

対象は無期限（Never expire）で発行されている常設の広い鍵（原則 3「常設の広い鍵を持つ主体を減らし続ける」に反する既存トークン）。scoped token への分解が構造的に不可能な場合（例: サービス側がアカウント単位でしか scope を切れない場合）、次善として **有効期限を切って再発行**し、漏洩時の被害期間を上限化する。**Supabase は 2026-08-17 時点で Dashboard に scoped project token の発行 UI（機能別 permission 選択 + 有効期限）が新設されており、Auth Config write を含む permission も個別選択できる。** 「アカウント単位でしか scope を切れず write 消費者がいると scoped 化できない」という前提は Supabase については成立しない（[#2126](https://github.com/Dayopt/dayopt/issues/2126)）。他サービスで同種の制約に当たった場合のみ、本節の expiry-only 再発行を使う。

手順（無停止での順序）:

1. 新規 token を **有効期限付き**（scoped 化できるサービスでは permission も必要最小限に絞る）で発行する（発行元サービスの UI/CLI で expiry / scope を設定。値は表示・記録しない）
2. 1Password master の該当 item / field を新しい値へ更新する（`op item edit`、実値を argv に直接書かない — 上記「op stdout 抑制」節の規律に従う）
3. 全消費者（MCP 登録、script の env 参照など）が新 token で動作することを確認する。参照は item / field 名で行われているため、通常は再登録不要（値の差し替えだけで反映される）
4. **新 token の provider 側「Last used」表示が Never から更新されたことを Dashboard で確認してから**、旧 token を revoke する。**疎通確認の 200 は false positive になりうる**: 1Password への保存が実際には反映されていない状態でも、ローカルの env 解決が古い値のまま残っていれば旧 token で 200 が返る。「疎通 200」だけを新 token 動作の証拠にしない — Last used の更新だけが新 token が実際に使われたことの証明になる（2026-08-17、Supabase `cli` token ローテーションで実際に発生: 疎通 200 ×2 が旧値で通り、旧 revoke 後に 401 が顕在化した。詳細は [#2086 の 2026-08-17 コメント](https://github.com/Dayopt/dayopt/issues/2086#issuecomment-5311036784)）
5. 旧 token を revoke する（4 の Last used 確認が終わるまで revoke しない — 旧 token が生きている間に新 token の動作確認を済ませる）

**期限管理**: 現状 1Password / 発行元サービスのいずれにも自動リマインダー機構は無い。次回ローテーション（または期限切れによる動作確認）は月次ガーデニングの棚卸し対象に含め、期限が近い token を検出したらこの手順で再発行する。

初事例は Supabase legacy `cli` token（Never expire・full access、[#2112](https://github.com/Dayopt/dayopt/issues/2112)）。当初裁可時点では消費者（cloud supabase MCP の `--read-only` 起動、`scripts/runbook/enable-auth-hook.sh` の Auth config write）のうち後者が write を要求するため read-only scoped token への完全置換はできないと判断していたが、作業中に scoped project token UI を発見し、**scoped token（`dayopt-cli-2026-08b`、90 日期限、Auth Config Write / Advisors・Logs Read / Database・Migrations Read の個別 permission）への切替**へ変更した。`dayopt-auth-config-audit`（[#1951](https://github.com/Dayopt/dayopt/issues/1951)）も次回 rotation 時に scoped + expiry へ寄せる選択肢がある。

---

## Unsafe / Temporary Commands

`vercel env pull` は通常の local dev flow ではない。使う場合は一時的な調査・復旧目的に限定する。

```bash
pnpm vercel:env:pull:unsafe
```

生成された `.env.local` は実値を含む可能性があるため unsafe / temporary として扱い、作業後に削除する。内容を terminal、chat、issue、docs に貼らない。

---

## Contact Delivery / Bot Protection

Cloudflare Turnstile が canonical provider。`NEXT_PUBLIC_TURNSTILE_SITE_KEY` は app / web の browser 側で使い、`TURNSTILE_SECRET_KEY` は web contact form と Supabase Dashboard replica で使う。

Product / Webの問い合わせはProductionだけResendへ送る。From / To / 件名はserver固定、送信者emailはReply-Toだけに使い、app別webhook署名secretを共用しない。Gmailの返信には`resend-support-replies`の専用SMTP keyだけを使う。

reCAPTCHA 関連 env は旧方式。新規設定・docs・example には追加しない。

---

## やっていいこと / やらないこと

### やっていいこと

- `op://` 参照を `.op-env.agent` に書く
- 1Password item / field 名を docs に書く
- secret の存在確認だけを出力する
- Vercel Production / GitHub / Supabase Dashboard の長寿命 replica を同期する

### やらないこと

- 実値を `.env.local` / `.op-env.agent.example` / docs に書く
- secret を terminal output、Slack、Issue、PR description に貼る
- `NEXT_PUBLIC_` だから安全、という判断で実値を公開する
- Production secret を通常の local dev から参照する
- PR Preview Branch credentials を 1Password に保存する
- `vercel env pull` を通常フローとして案内する

---

## 関連

- `.op-env.agent.example` — local injection 参照例
- `apps/web/src/lib/turnstile/` — Turnstile 実装
- `docs/engineering/infra.md` — Supabase / deployment 環境構成
- `docs/operations/security/environment-secrets.md` — GitHub / Vercel / Supabase replica
- `docs/operations/contact-email.md` — 問い合わせのDNS / mailbox / release運用
