---
status: current
last_verified: 2026-09-07
---

# Dayopt Glossary — 用語集

Dayopt の語彙の正本。UI で使う言葉、docs でだけ使う設計語、コード識別子と DB 名の対応を 1 概念 1 行で引ける形にまとめる。人間と AI の共通言語。

**正本は [`scripts/lib/glossary/terms.ts`](../../scripts/lib/glossary/terms.ts)**。下の表と禁止表記一覧はそこから生成される。用語を足す・変える時は `terms.ts` を編集して `pnpm glossary:generate` を実行する（この md を直接書き換えると `pnpm docs:check` が落ちる）。

## 3 つの層

| 層       | 何か                                    | 機械強制                                               |
| -------- | --------------------------------------- | ------------------------------------------------------ |
| `ui`     | UI 文言に出る呼称。ja / en を確定する   | `pnpm copy:check` が `messages/{ja,en}` をスキャンする |
| `design` | docs / spec で使う設計語。UI には出ない | なし（レビューで拾う）                                 |
| `code`   | 識別子と DB 名の対応。UI 表記を持たない | なし（`pnpm lint:boundaries` 等が別の面を見る）        |

「決算バー」「羅針盤」のような設計語を UI 文言に書かないこと、逆に UI 用語をコード識別子の正解と取り違えないことが、層を分ける目的。

## 確認コマンド

```bash
# 用語集を再生成する（terms.ts を編集したら必ず実行）
pnpm glossary:generate

# 生成物が terms.ts と一致するか（pnpm docs:check にも配線済み）
pnpm glossary:check

# messages の禁止表記をスキャン（警告のみ）
pnpm copy:check

# CI と同じ基準（enforcement: active だけを exit 1 にする）
pnpm copy:check:strict
```

関連: 実装ガイドは [`docs/engineering/i18n.md`](../engineering/i18n.md)、トーン・CTA 階層・数字フレーミングは [`docs/product/copywriting.md`](./copywriting.md)、Storybook 用語（CSF, Meta, Story 等）は [`docs/engineering/storybook.md`](../engineering/storybook.md)。

<!-- glossary:generated:start — 正本 scripts/lib/glossary/terms.ts / 再生成 pnpm glossary:generate / 検証 pnpm glossary:check。この範囲は手編集しない -->

## 用語表

1 概念 = 1 行。`ui` は UI 文言に出る呼称（`pnpm copy:check` の対象）、`design` は docs / spec でだけ使う設計語、`code` は識別子と DB 名の対応。

### UI 用語

| Concept                 | ja                   | en             | code / DB                                                                            | 禁止表記 (ja)                     | 禁止表記 (en)                      | 使い方                                                                               |
| ----------------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Timeblock               | タイムブロック       | Timeblock      | `features/timeblock` / `messages/timeblock.json`                                     | ブロック / 箱 / エントリ / タスク | block / box / event / entry / task | カレンダー上の時間ブロック。予定 / 記録の総称                                        |
| Plan                    | 予定                 | Plan           | `PlanEvent` / `features/timeblock`<br>`plans`                                        | 計画                              | —                                  | これからやる時間の宣言。時間軸のどこにでも置ける独立エンティティ                     |
| Record                  | 記録                 | Record         | `RecordEvent` / `features/timeblock`<br>`records`                                    | 実績                              | —                                  | 実際に使った時間。1 予定に複数紐づく（1:N）。未来には終われない                      |
| Timeboxing              | タイムボックス       | Timebox        | —                                                                                    | —                                 | —                                  | 時間を区切って作業する手法そのもの。説明文脈で使う（個々の時間は「タイムブロック」） |
| Activity                | アクティビティ       | Activity       | `features/activities` / `messages/activities.json`<br>`activities`                   | タグ / ラベル                     | —                                  | 予定と記録の単位。最も具体的な分類で、無限に増えてよい                               |
| Category                | カテゴリー           | Category       | `categories`                                                                         | —                                 | —                                  | 所属の主軸。1 アクティビティは最大 1 カテゴリー。色とアイコンを持つ                  |
| Segment                 | セグメント           | Segment        | `features/review`<br>`segments` / `segment_activities`                               | 束 / レンズ                       | lens                               | 分析用の保存されたクエリ。所属ではなく横断参照なので合計比率を持たない               |
| Uncategorized           | 未分類               | Uncategorized  | `UNCATEGORIZED_KEY`                                                                  | —                                 | —                                  | どのカテゴリーにも入っていない時間の残余バケット                                     |
| Plan template           | テンプレート         | Template       | `planTemplates` / `features/timeblock`<br>`plan_templates` / `plan_template_blocks`  | 型                                | —                                  | 1 日の予定の並びを保存して別の日へ適用する仕組み                                     |
| Review                  | 振り返り             | Review         | `features/review` / `messages/report.json`                                           | レビュー                          | —                                  | ページ名・機能名。route は /report、i18n namespace も report                         |
| Inspector               | インスペクタ         | Inspector      | `DockedInspectorPanel` / `features/timeblock`                                        | —                                 | —                                  | タイムブロックをクリックした時に開く詳細パネル                                       |
| Draft                   | ドラフト             | Draft          | `isDraft` / `DraftTimeblock`                                                         | —                                 | —                                  | 未保存のプレビュー状態のタイムブロック。ドラッグ中・複製直後など                     |
| Archive                 | アーカイブ           | Archive        | `archiveActivity`<br>`activities.archived_at` / `categories.archived_at`             | —                                 | —                                  | アクティビティ / カテゴリーを一覧から隠す。過去の記録は残る（削除ではない）          |
| Trash                   | ゴミ箱               | Trash          | `deleted_at`<br>`plans.deleted_at` / `records.deleted_at`                            | —                                 | —                                  | 削除したタイムブロックの soft delete 置き場。復元できる                              |
| Confirm day             | この日を確定         | Confirm day    | `confirmDay`<br>`confirm_day_plans_command_v1`                                       | —                                 | —                                  | 過去の予定をまとめて記録へ変換する操作                                               |
| Fulfillment             | 充実度               | Fulfillment    | `'low' \| 'medium' \| 'high'`<br>`records.fulfillment`                               | —                                 | —                                  | 記録に付ける 3 値。low = 消耗 / medium = 普通 / high = 充実                          |
| Progress                | 進捗                 | Progress       | —                                                                                    | 達成                              | —                                  | 予定に対して記録がどこまで進んだかを数字で示す                                       |
| External calendar event | 外部カレンダーの予定 | External event | `ExternalCalendarEvent` / `features/external-calendar`<br>`external_calendar_events` | —                                 | —                                  | Google Calendar 等から同期した予定。未変換のものはゴーストとして薄く出す             |
| Account                 | アカウント           | Account        | —                                                                                    | —                                 | —                                  | 設定ページ名                                                                         |
| Sign in                 | サインイン           | Sign in        | —                                                                                    | ログイン                          | log in                             | 認証アクション                                                                       |
| Sign out                | サインアウト         | Sign out       | —                                                                                    | ログアウト                        | log out                            | 認証解除アクション                                                                   |
| Allocation (chapter 1)  | 配分                 | Allocation     | `AllocationChapter`                                                                  | —                                 | —                                  | 1 章。時間そのものを分母（週 = 168h）に置いて、どこへ流れたかを見る                  |
| Execution (chapter 2)   | 執行                 | Execution      | `ExecutionChapter`                                                                   | —                                 | —                                  | 2 章。予定に対して記録がどう動いたか。全体遵守率のような合成値は作らない             |
| Quality (chapter 3)     | 質                   | Quality        | `QualityChapter`                                                                     | —                                 | —                                  | 3 章。投下時間と充実 / 消耗の関係を見る。中の散布図が「羅針盤」                      |
| Tidy (chapter 4)        | 整える               | Tidy           | `TidyChapter`                                                                        | —                                 | —                                  | 4 章。未変換の外部カレンダー予定など、来週へ持ち越す前に片づけるもの                 |

### 設計語（UI 文言には出さない）

| Concept          | ja           | en               | 禁止表記 (ja) | 使い方                                                                                       |
| ---------------- | ------------ | ---------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Ink              | インク       | Ink              | —             | 記録として書かれた時間。決算バーの塗り                                                       |
| Margin           | 余白         | Margin           | 空白 / 無駄   | 記録が書かれていない時間。分母には入るが塗らない。フィルタで動かない                         |
| Ledger bar       | 決算バー     | Ledger bar       | —             | 1 章の横 1 本のバー。塗りがインク、塗り残しが余白。UI にラベルとしては出さない               |
| Mirror           | 見積もりの鏡 | Mirror           | —             | 2 章の節。記録 / 過去予定の係数を癖の強い順に最大 3 件出す                                   |
| Compass          | 羅針盤       | Compass          | —             | 3 章の散布図。横軸が投下時間、縦軸が充実と消耗の差。平均・回帰線・象限は作らない             |
| Two-lane view    | 2 レーン表示 | Two-lane view    | —             | 予定レーン（アウトライン・淡色）と記録レーン（塗り・主役）を横並びに出す                     |
| Destination rule | 保存先ルール | Destination rule | —             | 新規作成は end_at だけで宛先が決まる（未来なら予定、過去なら記録）。種別選択の UI は置かない |

### コード内部語

| Concept               | 識別子                                   | DB                                                                     | 意味                                                                                                                                                                     | 状態   |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Timeblock destination | `TimeblockDestination` / `kind` / `lane` | —                                                                      | 予定 / 記録の判別子。canonical は 'plan' \| 'record'。kind / lane / destination / sourceKind / resourceType が現状混在している                                           | 現行   |
| Timeblock state       | `TimeblockState`                         | —                                                                      | 時間位置から導く 3 値（upcoming / active / past）。実体は useCalendarData が持つ                                                                                         | 現行   |
| Source                | `PlanSource` / `RecordSource`            | `plans.source` / `records.source`                                      | 作成時に確定する不変の provenance。plans は manual / external_calendar / api、records はそれに from_plan / auto_migrated を加えた 5 値                                   | 現行   |
| Ghost                 | `useConvertGhostEvent` / `GhostRenderer` | —                                                                      | コード内で 3 つの無関係な意味に使われている: 外部カレンダーの未変換予定 / DnD 中の描画 / Button の variant                                                               | 現行   |
| Restore               | `restoreActivity` / `restorePlan`        | —                                                                      | 3 つの無関係な操作が同じ動詞を使っている: アーカイブ解除 / ゴミ箱からの復元 / バックアップ復元                                                                           | 現行   |
| title / name          | —                                        | —                                                                      | 時間を持つものは title（plans / records / plan_template_blocks / external_calendar_events）、分類は name（activities / categories / segments / plan_templates）          | 現行   |
| note / description    | —                                        | `plans.note` / `records.note` / `external_calendar_events.description` | Dayopt 自身のメモは note。description は外部カレンダー由来の本文と、MCP / メタタグの説明文にだけ使う                                                                     | 現行   |
| Subscription status   | —                                        | `profiles.subscription_status`                                         | free / trialing / active / past_due / canceled。値の意味は docs/product/specs/billing.md                                                                                 | 現行   |
| Timeblock origin      | `TimeblockOrigin`                        | —                                                                      | 'planned' \| 'unplanned'。生成元で意味が 2 つに割れており（予定そのものか / 予定に紐づく記録か）、主要な呼び出し側は既に kind から再計算して迂回している。撤去は別 issue | 非推奨 |

### 廃止予定

| Concept | ja                      | en   | DB / 識別子                             | 理由と参照                                                                                      |
| ------- | ----------------------- | ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Skip    | スキップ / やらなかった | Skip | `plans.skipped_at`<br>`skip` / `unskip` | 概念ごと撤去する方針。新しい文言・docs でこの語彙を増やさない / decisions.md 2026-09-07 / #2636 |

## 禁止表記一覧

`pnpm copy:check` が `apps/product/messages/{ja,en}` をスキャンする。`CI 必須` は `pnpm copy:check:strict`（`pnpm check:static` 経由）で exit 1 になる。

| 禁止語     | locale | 推奨           | 強制           | 例外                                                                                              | 理由                                                                                                                          |
| ---------- | ------ | -------------- | -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ブロック   | ja     | タイムブロック | 移行中（警告） | —                                                                                                 | 総称は「タイムブロック」に統一する。単独の「ブロック」は妨害の意味とも読める                                                  |
| 箱         | ja     | タイムブロック | 移行中（警告） | —                                                                                                 | /report だけで使われている 3 つ目の呼称。「タイムブロック」か「件」に寄せる                                                   |
| エントリ   | ja     | タイムブロック | CI 必須        | —                                                                                                 | ADR-025 で廃止した旧 Entry 単一モデルの呼称。Plan / Record に分割済み                                                         |
| タスク     | ja     | タイムブロック | 移行中（警告） | キー `^legal\\.` / キー `^app\\.keywords`                                                         | GTD のタスクリスト項目と混同する。Dayopt が置くのはタスクではなく時間。法的文書と SEO keyword は据え置き                      |
| block      | en     | Timeblock      | 移行中（警告） | —                                                                                                 | ja「タイムブロック」に対応する en は Timeblock。単独の block は使わない                                                       |
| box        | en     | Timeblock      | 移行中（警告） | —                                                                                                 | /report の 3 つ目の呼称                                                                                                       |
| event      | en     | Timeblock      | 移行中（警告） | キー `^calendar\\.external\\.` / キー `externalEvents` / キー `ghost` / 概念 `external-event`     | event は外部カレンダー由来の予定を指す語。Dayopt 自身の時間には使わない                                                       |
| entry      | en     | Timeblock      | 移行中（警告） | キー `^oauth\\.consent\\.scope\\.` / キー `^settings\\.integrations\\.mcpConnections\\.scopes\\.` | 旧 Entry モデルの呼称。OAuth scope 名 read:entries は外部契約なので据え置き                                                   |
| task       | en     | Timeblock      | 移行中（警告） | キー `^legal\\.` / キー `^app\\.keywords`                                                         | ja「タスク」と同じ理由                                                                                                        |
| 実績       | ja     | 記録           | 移行中（警告） | —                                                                                                 | UI では「記録」に統一する。「実績」は評価の含みがあり、判定せず数字で示すという原則に反する                                   |
| タグ       | ja     | アクティビティ | CI 必須        | —                                                                                                 | 所属（集計が合う軸）と横断参照（分析）を 1 語に混ぜており集計が濁る。#2162 でアクティビティ / カテゴリー / セグメントへ全置換 |
| ラベル     | ja     | アクティビティ | CI 必須        | —                                                                                                 | 1 対象に複数付けられる印象を与える。1 タイムブロック 1 アクティビティ                                                         |
| 束         | ja     | セグメント     | 移行中（警告） | —                                                                                                 | /report のモバイル chip だけで使われている別名。「セグメント」に一本化する                                                    |
| レンズ     | ja     | セグメント     | 移行中（警告） | —                                                                                                 | 同上。spec と UI で「レンズ」「束」「セグメント」が三つ巴になっていた                                                         |
| lens       | en     | Segment        | 移行中（警告） | —                                                                                                 | ja「レンズ」と同じ理由                                                                                                        |
| 型         | ja     | テンプレート   | 移行中（警告） | —                                                                                                 | 同じ namespace 内で「テンプレート」と割れていた。DB / en / サイドバー見出しに合わせて「テンプレート」へ寄せる                 |
| レビュー   | ja     | 振り返り       | CI 必須        | 値に「プレビュー」 / 値に「法的レビュー」 / 値に「レビューを受ける」 / 値に「レビューインサイト」 | コードレビューや評価を連想させる。ページ名は「振り返り」                                                                      |
| 達成       | ja     | 進捗           | 移行中（警告） | —                                                                                                 | 「達成率」「達成度」は良し悪しの判定語。判定せず数字で示すという copywriting 原則に反する                                     |
| ログイン   | ja     | サインイン     | 移行中（警告） | キー `^legal\\.`                                                                                  | 「サインイン」に統一する。法的文書は改訂扱いになるため据え置き                                                                |
| log in     | en     | Sign in        | 移行中（警告） | キー `^legal\\.`                                                                                  | en 側も log in / sign in で割れている                                                                                         |
| ログアウト | ja     | サインアウト   | 移行中（警告） | キー `^legal\\.`                                                                                  | 「サインアウト」に統一する                                                                                                    |
| log out    | en     | Sign out       | 移行中（警告） | キー `^legal\\.`                                                                                  | ja「ログアウト」と同じ理由                                                                                                    |
| 空白       | ja     | 余白           | 移行中（警告） | `report` namespace のみ検査                                                                       | レポートでは「余白」。入力バリデーションの whitespace 義は別物なので report namespace だけを見る                              |
| 無駄       | ja     | 余白           | 移行中（警告） | —                                                                                                 | 余白に良し悪しの評価を持ち込まない                                                                                            |

### キー名に使わない token

キーパスを `.` と camelCase 境界で分割した token と**完全一致**で判定する（`ariaLabel` の `label` や `sentryReport` の `sentry` を誤検知しないため）。値が正しくてもキー名が旧語彙だと、AI が既存キーを手本にして旧語彙を再生産する。

| token     | 推奨                          | 強制           | 例外                                                                                    | 理由                                                                    |
| --------- | ----------------------------- | -------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `task`    | timeblock / plan              | 移行中（警告） | `^legal\\.`                                                                             | 旧語彙。Dayopt はタスクではなく時間を置く                               |
| `tasks`   | timeblock / plan              | 移行中（警告） | `^legal\\.`                                                                             | 同上（複数形）                                                          |
| `entry`   | timeblock / plan / record     | 移行中（警告） | `manualEntry$`                                                                          | ADR-025 で廃止した Entry モデルの名残。MFA コードの manual entry は別義 |
| `entries` | timeblock / plan / record     | 移行中（警告） | `^oauth\\.consent\\.scope\\.` / `^settings\\.integrations\\.mcpConnections\\.scopes\\.` | 同上。OAuth scope 名 read:entries は外部契約なのでキー名ごと据え置き    |
| `tag`     | activity / category / segment | 移行中（警告） | —                                                                                       | #2162 で廃止した Tag 機能の名残                                         |
| `tags`    | activity / category / segment | 移行中（警告） | —                                                                                       | 同上（複数形）                                                          |
| `event`   | timeblock / plan              | 移行中（警告） | `^calendar\\.external\\.` / `externalEvents` / `ghost`                                  | event は外部カレンダー由来の予定にだけ使う                              |
| `events`  | timeblock / plan              | 移行中（警告） | `^calendar\\.external\\.` / `externalEvents` / `ghost`                                  | 同上（複数形）                                                          |

## スキャン対象外（誤検知防止）

文脈によって正しい使い方があるため機械判定しない語。レビューで拾う。

| 語句 | locale | 推奨 | 理由                                                                                                     |
| ---- | ------ | ---- | -------------------------------------------------------------------------------------------------------- |
| 計画 | ja     | 予定 | 名詞の「計画」は使わないが、動詞「計画する」「計画どおり」は正当。部分一致では割れないためレビューで拾う |

<!-- glossary:generated:end -->

---

## 詳細ノート

表に載らない判断理由だけを置く。用語の定義そのものは上の表が正本。

### タイムブロック / 予定 / 記録

Plan（予定）と Record（記録）は独立エンティティで、その総称が「タイムブロック」。UI・コード識別子・feature ディレクトリ・i18n namespace をすべて `timeblock` で揃えている（2026-09-07 確定）。「ブロック」「箱」「Block」「box」は同じものの別名として散っていたので寄せる。

**時刻の規則は 2 本だけ**（2026-09-04 に「未来 Plan」の特別扱い 4 種を撤去した）:

| 規則                                             | 対象          | 強制点                                                    |
| ------------------------------------------------ | ------------- | --------------------------------------------------------- |
| `end_at > start_at`                              | Plan / Record | DB trigger（`DT003`）                                     |
| **Record は未来に終われない**（`end_at <= now`） | Record        | DB trigger `validate_record_temporal_write_v1`（`DT005`） |

- **Plan** は時間軸のどこにでも置ける。過去の Plan もドラッグ移動・リサイズ・時間編集ができ、編集しても Plan のままで Record へは変わらない
- **Record** は過去の事実。終了を未来へ動かす編集だけ不可。紐付け先 Plan がどこにあるかは制約しない
- **保存先ルール**: 新規作成時に保存先を選ぶ UI は無い。`end_at > now` なら Plan、`end_at <= now` なら Record として一意に決まる（`resolveTimeblockDestination`）。UI に種別選択の一手を足さない
- **強制点は DB trigger / SQL 関数**。アプリ層（service / MCP client / UI）はその写し

Review で区別する 3 つの状態:

- **未記録の予定** — 過去の Plan で Record が無い。「まだ記録していない」
- **やらなかった予定** — `skipped_at` があるもの。**この概念は廃止予定**（下記）
- **予定外の記録** — Record に `plan_id` が無いもの。Calendar 上に可視のマーカーは持たず、Review の差分集計でのみ扱う（旧「予定外」/「Unplanned」マーカーと「予定に戻す」導線は 2026-09-04 に UI から撤去済み）

### アクティビティ / カテゴリー / セグメント

2026-08-18 に「タグ」の多重所属を廃止し、3 構造へ全置換した（#2162）。タグは「所属（集計の足し算が合う軸）」と「横断参照（分析）」を 1 つの仕組みに混ぜており、集計が濁っていた。

| 構造     | 役割                                          | 集計の性質       |
| -------- | --------------------------------------------- | ---------------- |
| activity | 予定と記録の単位。最も具体                    | 分割（重複なし） |
| category | 所属の主軸。1 アクティビティ最大 1 カテゴリー | 分割（重複なし） |
| segment  | 分析用の保存されたクエリ                      | **重複しうる**   |

- アクティビティは無限に増えてよい（作成コストは激安のまま）。カテゴリーは色とアイコンを持つ
- どのカテゴリーにも属さないアクティビティ、およびアクティビティ未設定のタイムブロックは、カテゴリー軸では 1 つの「未分類」へ畳む
- セグメントは所属ではないため合計比率を持たない。円グラフ・積み上げ棒・「合計 100%」で見せない。UI に出ていた「レンズ」「束」は同じものの別名なので撤去する

### レポートの章と節（`/report`）

章と、その中の節・図を分けて呼ぶ。章名は UI に出る（`report.*.kick`）が、節と図の名前（決算バー・見積もりの鏡・羅針盤）は設計語で、UI にはラベルとして出さない。

| 章         | 中で使う設計語           | 作らないもの                             |
| ---------- | ------------------------ | ---------------------------------------- |
| 1 · 配分   | インク / 余白 / 決算バー | 「使い切った / 足りない」の評価          |
| 2 · 執行   | 見積もりの鏡             | 全体遵守率のような合成値                 |
| 3 · 質     | 羅針盤                   | 平均・回帰線・象限の塗り分け・ランキング |
| 4 · 整える | —                        | —                                        |

- **インク**: 記録として書かれた時間。決算バーの塗り
- **余白**: 書かれていない時間（`期間の長さ − 全記録`）。決算バーの塗り残しとして残し、**灰色ブロックで塗らない**。フィルタで動かない（カテゴリーを隠しても値は変わらない）
- **見積もりの鏡**: `記録 / 過去予定` の係数が癖の強い順に最大 3 件
- **羅針盤**: 横軸が投下時間、縦軸が充実と消耗の差の散布図。充実の回答が 5 件未満のアクティビティは点にせず「待っているもの」へ回す

いずれも評価語ではない。「精度」「達成」「スコア」を UI 文言に混ぜない。

### skip（やらなかった）は廃止予定

`plans.skipped_at` と skip / unskip 操作は概念ごと撤去する方針（2026-09-07 確定）。撤去自体は DB カラム・MCP 公開契約・公開 docs に及ぶ不可逆変更なので [#2636](https://github.com/Dayopt/dayopt/issues/2636) で扱う。**新しい UI 文言・docs・spec でこの語彙を増やさない**。現存する機能の説明は [`specs/plan-record.md`](./specs/plan-record.md) にある。

### 同音異義と除外の判断理由

機械判定は `value.includes()` の部分一致か、明示した正規表現で行う。以下は「禁止語に見えるが機械で一律に落とせない」ケースとその扱い。

- **「カテゴリ」を禁止語から外した**（2026-08-18、#2162）— 部分一致では正解語「カテゴリー」がすべて違反判定される。旧モデルでは `カテゴリ` は「タグの代替表現」として禁止していたが、3 構造モデルで「カテゴリー」が正解語に昇格したため役目を終えた。同じ形を避けるため、「ブロック」は `(?<!タイム)ブロック`、「箱」は `(?<!ゴミ)箱`、「束」は `(?<!約)束` という lookbehind 付きで判定する
- **「計画」は機械判定しない** — 名詞の「計画」は使わないが、動詞「計画する」「計画どおり」は正当。部分一致では割れないのでレビューで拾う
- **「空白」は `report` namespace だけ見る** — レポートの「余白」の禁止代替語としては正しいが、入力バリデーションの whitespace 義（「改行や空白のみは使用できません」）は別物
- **「ラベル」は値だけを見る** — 禁止しているのは UI 文言に出る「ラベル」で、a11y の `aria-label` は別義。キー名の検査 token に `label` を入れていないので `ariaLabel` は当たらない（値側の active ルールには除外を付けない — 未検証の抜け道になる）
- **「イベント」「event」は外部カレンダーでは正当** — Google Calendar のイベントを指す文脈と、Dayopt 自身の時間を指す旧語彙を区別するため、`calendar.external.*` / `externalEvents` / ghost 系のキーだけ許容する
- **外部契約のキー名は据え置き** — OAuth scope 名 `read:entries` と、それに従属する MCP 接続画面のキーは旧語彙のままにする。改名は外部 consumer を壊す（REVIEW-3）
- **法的文書は据え置き** — `legal.*` の「タスク」「ログイン」は改訂扱いになるため機械判定から外す

### キー名も検査する理由

値が正しくてもキー名が旧語彙だと、AI が既存キーを手本にして旧語彙を再生産する。`calendar.event.*` に 40 キーがぶら下がっていたのがその状態だった。キーパスを `.` と camelCase 境界で分割した token と**完全一致**で判定するので、`ariaLabel` の `label` や `sentryReport` の `sentry` は誤検知にならない。

### スキャン範囲

**LP（`apps/web`）は scanner 対象外。語彙統一は手動レビューで担保する**（2026-08-18 確定）。この用語集が定義するのは製品 UI（`apps/product`）の文言で、LP はブログ / docs のタグ分類のような別ドメインの語彙を多く含む（同じ「タグ」という語が「Dayopt のタグ機能」と「ブログ記事の分類ラベル」の両方を指すため、機械的な置換だと後者を壊す）。範囲を製品 UI 文言に限定するのが概念的に正しく、LP の変更頻度も低いため手動レビューで足りると判断した。

### この用語集が持たないもの

| 内容                              | 正本                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature の依存 DAG（Layer 0〜2）  | [`apps/product/eslint.config.mjs`](../../apps/product/eslint.config.mjs)（`pnpm lint:boundaries` が強制）。説明は [`AGENTS.md`](../../AGENTS.md) §アーキテクチャ |
| Composition Layer / Barrel Export | [`docs/engineering/conventions.md`](../engineering/conventions.md)                                                                                               |
| サブスクリプション状態の意味      | [`specs/billing.md`](./specs/billing.md)                                                                                                                         |
| 各機能の振る舞い                  | [`specs/`](./specs/)                                                                                                                                             |
