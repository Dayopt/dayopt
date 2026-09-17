---
status: current
last_verified: 2026-08-14
code: apps/product/src/features/external-calendar/schemas/google.ts
---

# Google OAuth sensitive scope 審査

Google Calendar 連携が使う sensitive scope の審査を出すための提出パッケージ。申請文・デモ動画の台本・提出前チェックリストをここに置く。

**一回性の作業ではないので repo に残す。** scope を増やす・OAuth client を作り直す・アプリの説明を変える、のいずれでも再審査になる。その時にゼロから書き直さずに済むよう、Google に何をどう説明したかを本ファイルで保持する。

GCP project 側の設定手順（API 有効化・scope 登録・client 作成・secret 投入）は [issue #1702 の手順書 v2](https://github.com/Dayopt/dayopt/issues/1702#issuecomment-5248264728) が正本。本ファイルは重複させず、審査に固有の部分だけを扱う。

## 要件の確認日と一次情報

2026-08-12 に以下を一次情報として確認した。Google はこの領域の要件と Console の UI をよく変えるので、**提出の直前に必ず読み直す**。本ファイルの記述と食い違ったら一次情報が正。

- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) — 提出手順とデモ動画の要件
- [Verification requirements](https://support.google.com/cloud/answer/13464321) — homepage / privacy policy / ドメイン検証の要件
- [Manage app data access](https://support.google.com/cloud/answer/15549135) — Console 上の scope 申告と justification の入力
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) — Limited Use。**sensitive scope にも適用される**（restricted 専用ではない）

審査期間は "can take up to 10 days to complete"（sensitive scope の場合）。restricted scope ではないので、第三者機関のセキュリティ評価（CASA）は不要。

## 現状と、提出前に閉じるべきもの

| 審査要件                                                                          | 現状                                                                                                                                                                                                                                        | 判定                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| App name / developer contact                                                      | GCP Console に登録済み                                                                                                                                                                                                                      | ✅                  |
| Homepage が検証済みドメイン上にあり機能を説明している                             | `https://dayopt.app`（200 を確認）                                                                                                                                                                                                          | ✅                  |
| プライバシーポリシーが homepage と同一ドメインにある                              | `https://dayopt.app/legal/privacy`（200 を確認）                                                                                                                                                                                            | ✅                  |
| プライバシーポリシーが **Google user data の扱いを開示**し Limited Use に準拠する | 記述が無い                                                                                                                                                                                                                                  | ❌ **ブロッカー 1** |
| 同意画面に scope が登録済み                                                       | `openid` / `email` / narrow pair（`calendar.calendarlist.readonly` / `calendar.events.readonly`）を登録済み。旧 `calendar.readonly` は未削除のまま残っている（2026-08-14、Main が console で登録・実測確認。#1982 の 5-1 完了コメント参照） | ✅                  |
| Authorized domains が Search Console で検証済み                                   | 外形から確認できない                                                                                                                                                                                                                        | ❓ **要確認**       |
| デモ動画が **scope を使う app の機能**を見せる                                    | 見せられる画面が存在しない                                                                                                                                                                                                                  | ❌ **ブロッカー 2** |
| 保持期間 90 日の約束が実際に執行されている                                        | cron 配線済み（2026-08-12 / 2026-08-13、account_delete 種別の settle 経路も #2055 で独立 cron `/api/cron/calendar-account-deletion-settle`（hourly）として配線完了）                                                                        | ✅                  |
| 要求する scope が最小である                                                       | narrow pair へのコード切り替え（#1982）と GCP console 登録（2026-08-14）が完了。既存接続は 0 行のため移行対象なし（#1982 実測）。旧 `calendar.readonly` の console 登録削除だけが未完了（§提出前チェックリスト ステップ 3）                 | ⚠️ **一部実施**     |

### ブロッカー 1: プライバシーポリシーに Google user data の記述が無い

Google は privacy policy に対して "Disclose the manner in which your application accesses, uses, stores, or shares Google user data" と "Must align with Google's Limited use requirements" を要求する。

現在の `apps/web/content/legal/{en,ja}/privacy.mdx` に Google が出てくるのは 2 箇所だけ。**どちらも Calendar 連携の説明になっていない。**

- `subProcessors.google` — Gmail をサポート問い合わせの受信箱として使う、という sub-processor の記載
- `legalBasis.contract` — "including account management, task storage, and calendar synchronization" という一語

取得する scope・保存するフィールド・保持期間・削除・Limited Use 準拠のいずれも書かれていない。**この状態で出すと落ちる。** 追加すべき記述の素案は §プライバシーポリシーに追加する記述 に置いた。

### ブロッカー 2: scope で取ったデータを使う画面が無い

Google はデモ動画に "The app functionalities that utilize the requested OAuth scopes" を要求し、Limited Use は "user-facing features that are **prominent in the requesting application's user interface**" を要求する。

一方 epic #1702 の DoD 6 は「Calendar 画面には何も表示されない」を**意図的に**達成した状態で、取り込んだ予定を表示する導線は現時点でゼロ。ユーザーから見える同期の証拠は Settings → Integrations の以下だけ（`apps/product/src/features/external-calendar/components/GoogleCalendarSettingsView.tsx`）。

- ステータスバッジ "Connected"
- "Last sync: {日時}"
- 手動同期後のトースト "Google Calendar synced"

取り込み件数の表示すら無い。つまり今のまま撮ると、動画は「Google にログインして同意したら、設定画面に Connected と出た」で終わり、**calendar.readonly で読んだ予定が何に使われるのかを一度も見せられない。**

**#1962（ミラーの UI 接続 / ghost 表示）を production に出してから提出する。** 審査の外部待ちを先に消化したくなるが、この状態で出して reject されると出し直しでかえって遅くなる。

### 解消済み: 90 日の保持期限の執行（旧ブロッカー 3）

申請文と privacy 素案は「revoke の記録は 90 日で自動削除される」と書いている。この文が真であるには、期限切れを消す処理が実際に定期実行されている必要がある。当初（本ファイル `last_verified: 2026-08-12` 時点）は実行されておらず、`delete_after` は設定されるが誰も見に来ない状態だった。

2 段の cron 配線で解消した:

- `private.cleanup_calendar_authority_retention_internal_v1`（`calendar_revoke_operations` / `calendar_authority_command_receipts` / `calendar_oauth_attempts` の `delete_after` 超過行と孤立 subject fence を削除）を `cleanup-calendar-authority-retention`（hourly, :50）に配線（`20260812041309`、`20260812071342` で 4 時間の safety margin を追加、#1994）
- `delete_after` は `pending` の間は常に NULL（`calendar_revoke_operations_state_shape` CHECK）で、`pending` → 終端状態（`revoked`/`expired`）への遷移は cleanup とは別の 2 関数（`private.expire_calendar_revoke_ciphertexts_internal_v1` と `private.finalize_calendar_revoke_guards_internal_v1`）が担う。この 2 本も未配線だったため、上の cleanup を配線しただけでは `pending` のまま滞留する行が解消されなかった（#2002）。`expire-calendar-revoke-authority`（:10）/ `finalize-calendar-revoke-guards`（:15）として配線し、`pending → 終端状態 → cleanup` の 3 段が全て駆動されるようにした（`20260813130000`、`20260813130100`）

**アカウント削除から 90 日を過ぎると Google の `sub` を含む記録は実際に削除される状態になっている。**

### narrow pair の対応状況: `calendar.readonly` はこのアプリにとって最小ではない

Google は "Request only the **narrowest** scope(s) needed" と要求し、justification 欄で「なぜより狭い scope では不十分か」を問う。

Dayopt が呼ぶ Calendar API は 2 つだけで、それぞれをより狭い scope が単独でカバーする（各 API リファレンスの Authorization セクションで確認）。

| 呼んでいる API      | 用途                                   | 旧・広い scope      | より狭い scope（#1982 でコードが要求する scope） |
| ------------------- | -------------------------------------- | ------------------- | ------------------------------------------------ |
| `calendarList.list` | ユーザーに取り込むカレンダーを選ばせる | `calendar.readonly` | `calendar.calendarlist.readonly`                 |
| `events.list`       | 選択されたカレンダーの予定を読む       | `calendar.readonly` | `calendar.events.readonly`                       |

つまり `calendar.calendarlist.readonly` + `calendar.events.readonly` の 2 本で用途を完全に満たし、`calendar.readonly` が追加で与える権限（ACL・設定・任意カレンダーの freebusy など）は**一つも使っていない**。

これは「落ちるかもしれない」以前に、**justification 欄に正直に書けない**ことを意味する。より狭い選択肢が実在する以上、「より狭い scope では不十分」と書けば虚偽になる。

**narrow pair へ切り替えた。** 4 ステップのうち 1〜3 が完了、4 は不要と判明した（#1982）。

1. ✅ `apps/product/src/features/external-calendar/schemas/google.ts` の `GOOGLE_AUTHORIZATION_SCOPES` を 2 本立てに変えた
2. ✅ `hasRequiredCalendarScopes()`（旧 `hasCalendarReadonlyScope()`、`server/google-oauth.ts`）の判定を **`(calendar.calendarlist.readonly && calendar.events.readonly) || calendar.readonly`** に広げた。**narrow pair は AND であって OR ではない** — Google の granular consent で片方だけ許可されうるので、いずれか 1 つで通す OR 判定にすると、接続は active として保存されたのに `calendarList.list` か `events.list` が恒久的に 403 になり「Connected なのに一覧が出ない / 同期されない」状態が残る。narrow scope が片方欠けた callback を拒否する test も入れた。旧 `calendar.readonly` を残すのは既存の接続済みユーザーがそれで grant 済みだから（この検査は callback 時にしか走らないため保存済み接続は壊れないが、再接続で落ちる）。削除条件は [#2072](https://github.com/Dayopt/dayopt/issues/2072) に記録した
3. ✅ **narrow pair 2 本の追加登録は完了**（2026-08-14、Main が console で実施・実測確認）。**旧 `calendar.readonly` の削除だけ未完了。** §提出前チェックリスト ステップ 3 を参照
4. ✅ **不要と判明した。** production の `calendar_connections` を実測した結果 0 行（既存接続ゼロ、#1982 で確認）だったため、移行対象そのものが存在しない。`syncConnection()` が `granted_scopes` を再検査しない設計（`server/sync-service.ts:179`）自体は変わらないが、新規接続はすべて narrow pair で作られるため実害は無い

狭くする目的は、審査を通しやすくすることと、ユーザーに渡す権限を実際の用途に合わせることの 2 つ。既存接続が 0 行だったため、**両方とも 1〜3 の完了時点で達成済み**。

### 要確認: ドメイン検証

`dayopt.app` の Search Console 検証状態が外形から判定できなかった。

- live HTML に `google-site-verification` の meta タグが無い（`GOOGLE_SITE_VERIFICATION` env が production 未設定と思われる）
- DNS の TXT レコードに検証トークンが無い
- repo の `apps/web/public/` に検証用 HTML ファイルが無い

HTML ファイル / Google Analytics / Tag Manager など別方式で検証済みの可能性はあるので、未検証と断定はしない。**Search Console を開いて確認する**（チェックリストのステップ 1）。未検証なら scope 申請そのものが進まない。

## 申請文

Console の入力欄にそのまま貼る英語テキスト。**事実だけを書く。** 誇張や、実装していない機能の記述を混ぜない — 動画と食い違うと落ちる。

以下の英文が主張する実装の事実（呼ぶ API、保存するフィールド、±90 日、切断時の挙動、暗号化）は 2026-08-12 に `risk-reviewer` の反証レビューで実装と 1 件ずつ突き合わせた。**同期の実装を変えたらこの英文も直す。** Google に出した説明と実装が食い違うのは、審査の指摘では済まず Limited Use 違反になりうる。

### App description（何をするアプリか）

```
Dayopt is a personal daily planning app. A user plans their day as time blocks,
then records what actually happened in the same timeline, so they can see the gap
between the plan and the result.

Most users already keep their meetings and appointments in Google Calendar. The
Google Calendar integration imports those existing commitments into Dayopt as
read-only entries, so the user can plan the rest of their day around them without
retyping each one. Dayopt never writes to, modifies, or deletes anything in Google
Calendar; the integration is one-way and read-only.

The integration is optional. Dayopt is fully usable without connecting a Google
account, and the user chooses exactly which of their calendars are imported.
```

### Scope justification — `calendar.calendarlist.readonly`（narrow pair を採用する場合）

```
Dayopt calls calendarList.list to show the user the list of their calendars so
they can choose which ones to import. It is called on demand, when the user opens
the integration settings screen for a connected account and after they change
their selection, so that the list they see is current. Only the calendar
identifier, the calendar name, and the primary flag are used. The identifier and
the name are stored alongside imported events so the user can tell which calendar
an entry came from.

This is the narrowest scope that authorizes calendarList.list. Dayopt does not
create, modify, or delete calendars, and does not read calendar ACLs or settings.
```

### Scope justification — `calendar.events.readonly`（narrow pair を採用する場合）

```
Dayopt calls events.list on the calendars the user explicitly selected, to import
their existing commitments into the user's Dayopt timeline. This is the feature
users connect the integration for: it lets them plan their day around meetings they
already have, instead of retyping each meeting into Dayopt by hand.

Every sync run computes a window of 90 days before and after the moment it runs.
Most runs do not send that window: they send the sync token Google issued and
receive only what changed in the set the last full request established. Once a day,
each connection is resynced in full, and that run does send the freshly computed
window. So the range does move forward with the current date, in daily steps rather
than continuously. Timed events are imported; all-day events are skipped.

From each event, Dayopt stores only these fields:
  - the event ID (to match the same event across syncs)
  - the title
  - the description
  - the start and end times
  - whether the event is still active or has been cancelled. This is Dayopt's own
    flag, set from whether Google reported the event as cancelled, so that an event
    the user cancelled in Google stops being shown as a live commitment.
  - the Google-assigned identifier and the name of the calendar the event came
    from, so the user can tell which calendar an entry belongs to. Note that for
    a user's own calendar this identifier is typically their own email address,
    and for a calendar another person shared with them it may be that person's
    email address.

Dayopt does not request a partial response, so the events.list reply it receives
is the standard Event resource. Every field Dayopt does not need is discarded at
the parsing boundary: attendees, guest email addresses, locations, conferencing
links, attachments, and organizers are never used, never stored, and never
written to logs.

This is the narrowest scope that authorizes events.list. Dayopt does not create,
modify, or delete events, and does not access free/busy information for calendars
the user has not selected.
```

### Scope justification — `calendar.readonly`（fallback、#1982 で不採用）

**#1982 で narrow pair への切り替えを実施したため、この fallback は不採用。提出には使わない。** 記録として残すのみ（GCP console から `calendar.readonly` の登録を削除する前に、旧 justification が誤って再利用されないようにするため）。

より狭い scope が存在する以上、「不十分だ」とは書かない。**採用する場合はこの弱さを承知の上で出す**（§narrow pair の対応状況 参照）。

```
Dayopt uses this scope for exactly two API calls:

  - calendarList.list, called on demand when the user opens the integration
    settings screen for a connected account and after they change their
    selection, so the user can choose which of their calendars to import and
    always sees a current list.
  - events.list, called on the calendars the user explicitly selected, to import
    their existing commitments into the user's Dayopt timeline.

Every sync run computes a window of 90 days before and after the moment it runs.
Most runs send Google's sync token instead and receive only what changed in the set
the last full request established; once a day each connection is resynced in full
using the freshly computed window, so the range moves forward with the current date
in daily steps. Timed events are imported; all-day events are skipped.

From each event, Dayopt stores only the event ID, the title, the description, the
start and end times, a flag of its own recording whether the event is still active
or has been cancelled (set from whether Google reported it as cancelled), and the
Google-assigned identifier and name of the calendar the event came from. Note that a calendar identifier is typically an email address:
the user's own for their own calendar, and the sharing person's for a calendar
shared with them. Dayopt does not request a partial response, so the events.list
reply it receives is the standard Event resource; every field it does not need is
discarded at the parsing boundary. Attendees, guest email addresses, locations,
conferencing links, attachments, and organizers are never used, never stored, and
never written to logs.

Dayopt never writes to Google Calendar. It does not create, modify, or delete
calendars or events.
```

### Scope justification — `openid` / `email`

sensitive ではないので justification 欄が出ないことがある。求められた場合はこれを使う。

```
openid is required because Google only returns an ID token for OpenID Connect
authentication requests. Dayopt uses the stable "sub" identifier from that ID token
to tell which Google account a connection belongs to, and to detect when a user
reconnects with a different account than the one originally connected.

email is used for two things. It is displayed in the app's integration settings
screen so that a user with more than one connected account can tell them apart.
It is also passed back to Google as the login_hint when the user reconnects an
account whose access has expired, so the consent screen suggests the same account
they connected originally. Dayopt does not rely on the email address for identity;
the account match is verified against the "sub" identifier described above.
```

### Data handling summary（別途聞かれた場合）

```
Refresh tokens are encrypted with AES-256-GCM at the application layer before being
stored. Access tokens are never persisted: one is obtained whenever Dayopt needs to
call Google on the user's behalf — when the account is first connected, when the
user's calendar list is loaded, and on each sync run — and is held in memory only
for the duration of that operation.

Dayopt also stores the email address and the stable account identifier ("sub") of
the connected Google account, so that it can show the user which account is
connected and confirm that a reconnection is for the same account. Both are deleted
when the user disconnects the account or deletes their Dayopt account.

Separately from the events themselves, Dayopt stores the user's calendar selection:
for each calendar the user chose to import, its Google-assigned identifier and its
name, and the sync token Google issues so the next sync only fetches what changed.
This is stored as soon as the user makes the selection and does not depend on any
event being imported, so it exists even for a calendar that turns out to have no
events in range. It is deleted when the user deselects the calendar, disconnects
the account, or deletes their Dayopt account.

Imported events are stored per user. Google user data is not sold, is not used for
advertising, and is not used to train any AI or machine learning model. It is not
transferred to third parties, with two exceptions:

  - the infrastructure providers that host the application, documented in the
    privacy policy;
  - destinations the user themselves sets up. Dayopt lets a user share their own
    Dayopt entries outward — today by authorizing another application to read them
    through Dayopt's API, and by enabling a calendar feed URL they can subscribe to
    from another calendar app. Where a user has built an entry from an imported
    Google event, that entry travels over whichever of these the user has turned
    on. Every such destination is one the user chose and can turn off again; Dayopt
    does not send data anywhere the user has not set up.

There are two ways a user ends the connection, and they differ in what is kept.

Disconnecting the account from Dayopt's settings: Dayopt asks Google to revoke the
refresh token on a best-effort basis, and completes the disconnect even if Google
cannot be reached, rather than leaving the user connected against their wishes. It
deletes the stored credentials, the connected account's email address and account
identifier, and every imported event the user has not built on. If Google issued a
replacement refresh token shortly before the disconnect, that replacement is held
encrypted in an internal queue for up to 24 hours, precisely so that Dayopt can
revoke it too; it is removed once revoked or when it expires. An imported event
the user has already turned into an entry of their own is kept, because deleting it
would remove part of the user's own history; the entry and the imported event it
came from both remain, and the imported event keeps the fields listed above.

Deleting the Dayopt account: everything above is deleted, including the imported
events that were kept in the disconnect case. A record that the revocation was
carried out, including the Google account identifier it applied to, is retained for
up to 90 days so that Dayopt can show a revocation was performed and can detect one
that silently failed. That record is deleted automatically at the end of that
period.

In both cases the user can also revoke Dayopt's access directly from their Google
account settings at any time, independently of Dayopt.
```

**この段落は 7 箇所で実装に合わせてある。書き換えるときに戻さない。**

**書き換えの原則: データの削除を無条件で保証する形に戻さない。** 実装には「消えない場合」が複数あり（下の 4 点）、1 つずつ潰す書き方をすると次の例外が見つかるたびに申告と実装がずれる。削除の方針と、その**例外の範囲**を書く形を維持する。

- **revoke は best-effort。** `revokeRefreshToken()`（`server/google-oauth.ts:299-322`）はネットワーク失敗や想定外のエラーで `false` を返し、`disconnect()`（`server/connection-service.ts:596-633`）はそれでも切断を続行する（`reportUnrevokedGrant` で Sentry に送る）。「revokes」と断定形で書くと、実際には失敗しうる動作を保証したことになる。アプリ内の確認ダイアログも "Dayopt will **try to** revoke Google access" と書いてある
- **削除されるのは参照されていないミラー行だけ。** ユーザーが自分の Plan / Record に紐づけた予定は履歴として残る（`connection_id` が NULL になる）。実際の順序は revoke → 未参照イベントの削除 → 接続行（= 認証情報）の削除
- **Google の `sub` はアカウント削除後も最大 90 日残る。** revoke operation が `delete_after = settled_at + INTERVAL '90 days'` で保持され（`supabase/migrations/20260730090013_calendar_authority_fence_commands.sql:479`）、その FK が `provider_account_id` を持つ subject fence の削除を阻む。「即座に全部消える」と書くとこれと食い違う
- **その 90 日記録が作られるのは*アカウント削除経路だけ*。** Settings からの通常切断は `disconnect()` が revoke と接続行削除を直接行うだけで、`calendar_revoke_operations` を作る RPC を呼ばない（この機構に触れるのは `server/account-deletion.ts` のみ）。90 日保持を切断一般の説明として書くと、存在しない処理を申告することになる
- **参照済みミラー行は「ユーザーの entry」とは別に残る。** 切断で消えるのは未参照行だけで、Plan / Record から参照されている行は `connection_id` が NULL になるだけ。**行自体は provider event ID・タイトル・説明・calendar ID / name・時刻を保持したまま残る**ので、「imported events を消して own history だけが残る」と書くと保持内容と食い違う
- **削除失敗を「監視に上がる」と書かない。** `event-pruning.ts` の DELETE 失敗分岐は `logger.warn` だけで Sentry へ送らない（select / 参照読み取りの失敗は `captureDatabaseError` を通るが、DELETE は通らない）。分岐ごとに監視の有無が違うので、一律に「失敗は報告される」と書くと成立しない
- **prune が失敗しても切断は成功として返る。** `deleteUnreferencedEvents()` は select / 参照読み取りの失敗で throw せず return し（`server/event-pruning.ts:141-169`）、`disconnect()` はそのまま接続行を hard delete する。残ったミラー行は `connection_id` が NULL になり、**この接続をキーにした回収経路が無くなる**（`connection-service.ts:590` のコメント自身がこの scope 喪失を認めている）。孤児行を掃除する経路は現時点で存在しない。**これは申告の問題ではなく実装の穴**なので、別 issue として Main へ上げた。塞がるまでは「必ず消える」と書かない

## デモ動画の台本

撮影は User。**動画は audit の対象で、審査官は同意画面のアドレスバーまで見る。** 撮り直しは審査 1 ラウンド分の待ち時間になるので、撮影条件を先に揃える。

### 撮影条件

| 条件         | 内容                                                                                                                                                                                                                                                          | 理由                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 言語         | **Dayopt の UI（`https://app.dayopt.app/en/...`）と Google 同意画面の両方を英語にする。** 後者は URL の `/en/` では変わらない — 撮影用 Google アカウントかブラウザの表示言語を英語にし、**録画前にシーン 5 まで一度通して同意画面が英語で出ることを確認する** | Google が "in English" を明示要求。`/en/` が効くのは Dayopt 側だけで、`accounts.google.com` の言語はアカウント / ブラウザ設定に従う。Dayopt だけ英語にして撮ると、同意画面が日本語のまま録れて撮り直しになる |
| アドレスバー | ブラウザのアドレスバーを**常に画面内に入れる**                                                                                                                                                                                                                | 同意画面 URL に含まれる client ID を審査官が確認する                                                                                                                                                         |
| アカウント   | 実際の Google アカウント。撮影で選ぶカレンダーに、**現在日時の前後 90 日以内の時刻指定の予定**が数件あること                                                                                                                                                  | 取り込み範囲が ±90 日で、終日予定は除外される。祝日・誕生日のような終日予定や範囲外の予定しか無いと、Apply も同期も成功するのにシーン 9 で何も出ず撮り直しになる                                             |
| 環境         | production（`https://app.dayopt.app`）                                                                                                                                                                                                                        | 審査対象の client ID で動く必要がある。Preview は OAuth 無効                                                                                                                                                 |
| 事前状態     | 対象アカウントを**一度 disconnect しておく**                                                                                                                                                                                                                  | 接続フローを頭から見せるため                                                                                                                                                                                 |
| 公開設定     | YouTube に**限定公開（unlisted）**でアップロード                                                                                                                                                                                                              | Google の要求。非公開だと審査官が見られない                                                                                                                                                                  |
| 音声         | 不要。字幕・キャプションがあると親切                                                                                                                                                                                                                          | 要求はされていない                                                                                                                                                                                           |

### シーン構成

| #   | 画面                                                          | 見せること                                                                                                                      | 尺        |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `https://dayopt.app`                                          | homepage。アプリが何をするものか分かる状態                                                                                      | 5 秒      |
| 2   | `https://app.dayopt.app/en/calendar?view=week` にログイン済み | 週表示。ここが「予定を計画する場所」だと分かる                                                                                  | 10 秒     |
| 3   | Settings → **Integrations**                                   | "Google Calendar" カード。説明文 "Choose which Google calendars to import into Dayopt." と **"Connect Google account"** ボタン  | 10 秒     |
| 4   | ボタンをクリック → Google の画面へ遷移                        | **アドレスバーを映したまま**。`accounts.google.com` の URL に client ID が入っているのが読める状態で一拍止める                  | 8 秒      |
| 5   | Google アカウント選択 → 同意画面                              | **アプリ名 "Dayopt" が表示されていること**と、要求している scope が全部読めること。スクロールして全 scope を映す                | 15 秒     |
| 6   | 「続行」→ Dayopt へ戻る                                       | callback 後に "Google account connected" のトーストが出る                                                                       | 5 秒      |
| 7   | Integrations の Google Calendar カード                        | **"Calendars to import"** のチェックボックス一覧。実際のカレンダー名が出ている。1〜2 個チェックして **"Apply"**                 | 15 秒     |
| 8   | 同カード                                                      | ステータス **"Connected"** と **"Last sync: {日時}"** が更新される。**"Sync now"** を押して "Google Calendar synced" のトースト | 10 秒     |
| 9   | **週表示に戻る**                                              | **取り込んだ Google の予定が、ユーザーの計画と並んで表示されている**。ステップ 7 で選んだカレンダーの予定だと分かる             | **20 秒** |
| 10  | 週表示                                                        | その予定を避けて自分のブロックを置く。scope で取ったデータが何の役に立つかを見せる                                              | 15 秒     |
| 11  | Integrations → **"Disconnect"**                               | 確認ダイアログ "Disconnect this Google account?" と説明文。実行して "Google account disconnected"                               | 10 秒     |
| 12  | 週表示                                                        | 取り込まれていた予定が消えている（ユーザー自身のブロックは残る）                                                                | 8 秒      |

合計 2 分強。

**ステップ 9・10・12 が動画の中核で、ブロッカー 2 が閉じていないと撮れない。** #1962 が production に出るまで、この 3 つは存在しない画面になる。ステップ 8 までで終わる動画は「同意は取ったが何にも使っていない」ように見えるため、提出しない。

### 撮り終えたら

- 通しで一度見て、**同意画面のアプリ名が "Dayopt" になっているか**を確認する（GCP のアプリ名を後から変えると再撮影）
- 個人情報が映り込んでいないか確認する。実カレンダーの予定タイトルは映る前提だが、見られて困るものが入っていないかは撮影者にしか判断できない
- YouTube に限定公開でアップし、URL を控える

## 提出前チェックリスト

User が GCP Console / Search Console で操作する項目。**上から順に実行する**（依存関係がある）。

### ステップ 1 — ドメイン検証を確認する

1. https://search.google.com/search-console を開く
2. プロパティ一覧に **`dayopt.app`** があり、検証済みになっているか確認する
3. 無ければ追加して検証する。**GCP project のオーナーまたは編集者である Google アカウントで行う**（別アカウントで検証しても審査に使えない）
4. ドメインプロパティ（DNS TXT）で検証すると `app.dayopt.app` も含めて一度で済む。DNS は Cloudflare

### ステップ 2 — 同意画面の登録内容を確認する

`https://console.cloud.google.com/auth/branding?project=dayopt-503623`

1. **アプリ名**が `Dayopt` になっている（動画に映る名前と完全一致させる）
2. **ユーザーサポートメール**が現行の連絡先になっている
3. **アプリのロゴ**が登録されている。未登録なら `apps/product/public/icons/icon-512.png` を使う。Google が公開している要件は **正方形・120×120px 推奨・1MB 以下・JPG / PNG / BMP** で、この画像は 512×512 の PNG（48KB）なので満たす。**ブランドを一意に識別できること**も要件なので、汎用アイコンや他社ロゴに似たものは使わない。透過の可否は公開ドキュメントに記載が無いため、Console のアップロード時の検証に従う（弾かれたら不透明な背景を敷いた版を作る）
4. **アプリケーションのホームページ** = `https://dayopt.app`
5. **プライバシーポリシー** = `https://dayopt.app/legal/privacy`
6. **利用規約** = `https://dayopt.app/legal/terms`
7. **承認済みドメイン**に `dayopt.app` が入っている
8. **デベロッパーの連絡先情報**が現行のメールアドレス

ロゴを新規登録・変更すると自動レビューが入り、**7 日以内に公開しないと再検証**になる。ロゴの差し替えは提出直前にまとめて行う。

### ステップ 3 — scope の登録を確認する

`https://console.cloud.google.com/auth/scopes?project=dayopt-503623`

**目標**: `openid` / `email` / `calendar.calendarlist.readonly` / `calendar.events.readonly` の 4 本のみ。**`calendar.readonly` は削除する**（fallback は #1982 で不採用済み、§Scope justification — `calendar.readonly` 参照）。

**現状（2026-08-14 実測）**: narrow pair 2 本の追加登録は完了。旧 `calendar.readonly` はまだ削除していない（5 本登録されている状態）。production の既存接続は 0 行（#1982 実測）なので同期を壊す心配は無いが、**削除は [#2072](https://github.com/Dayopt/dayopt/issues/2072) の OR 分岐削除条件（開発者個人アカウント等、production DB に載らない旧 grant が残っていないことの確認を含む）を満たしてから行う**。

**アプリ側が要求する scope と完全に一致させる**（`GOOGLE_AUTHORIZATION_SCOPES`）。ここに登録されていない scope を要求すると同意画面でエラーになり、逆に余分に登録すると審査官に「使っていない scope を要求している」と見なされる。

### ステップ 4 — 前提が全部閉じているか確認する

- [ ] プライバシーポリシーに Google Calendar の節が公開済み（ブロッカー 1）。`https://dayopt.app/legal/privacy` を実際に開いて目視する
- [ ] #1962 が production に出ていて、週表示に取り込んだ予定が出る（ブロッカー 2）
- [ ] 90 日の保持期限を消す処理が定期実行されている、または自動削除の記述を文面から外した（ブロッカー 3）
- [ ] デモ動画を撮影して YouTube に限定公開で上げた
- [ ] 動画の中の同意画面に出るアプリ名が、ステップ 2 のアプリ名と一致している
- [ ] **申請文の主張を実装と突き合わせ直した**（下記）

**最後の 1 つは飛ばさない。** この申請パッケージのレビューでは、6 巡にわたって毎回「申請文が実装より強く / 広く書けている」箇所が新しく見つかった（計 19 件）。個々の文言を直しても、実装が動けばまた同じ型の食い違いが生まれる。**申請文は書いた時点の実装のスナップショットであって、提出時点の真実ではない。**

提出直前に、次のカテゴリごとに一次情報（コード）と突き合わせる。主担当が現在のコードと検証結果を確認し、範囲が大きく独立した読み取りが有効な場合だけ `pnpm agent:readonly` を使う。委譲した出力は親担当が一次情報と再照合し、レビュー完了や申請承認の証明にはしない。

| カテゴリ              | 確認すること                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| 呼ぶ API              | Google のどのエンドポイントを、どの契機で叩くか。増えていないか                      |
| 保存するもの          | event・接続アカウント・選択カレンダーそれぞれで、実際に永続化される列                |
| 取得範囲              | ±90 日、終日除外、増分同期の使い方                                                   |
| 消えるもの / 残るもの | 切断とアカウント削除で結果が違う。保持期間の約束は実際に執行されているか             |
| 外へ出る経路          | ユーザーが設定した送信先（API 連携・iCal フィード等）が増えていないか                |
| 断定の強さ            | 「必ず消える」「〜だけ」「〜しない」と書いた箇所が、失敗分岐や例外を無視していないか |

### ステップ 5 — 審査を申請する

`https://console.cloud.google.com/auth/verification?project=dayopt-503623`

1. 「確認を準備」/「Prepare for verification」から申請フォームを開く
2. 各 sensitive scope に §申請文 の justification を貼る
3. デモ動画の YouTube URL を貼る
4. 内容を読み返してから送信する

送信後、**同じ project の scope を変更しない**。変更すると審査がやり直しになる。

### ステップ 6 — 提出したことを記録する

#1963 に提出日・提出した scope・動画 URL をコメントする。Google からの指摘も同じ issue に集約する。

## 審査中・審査後

- **審査期間は最大 10 日**。Google からの連絡は同意画面に登録した「デベロッパーの連絡先情報」宛に来る。**このメールを見落とすと審査が止まる**ので、提出したら受信箱を見ておく
- 追加質問が来ることがある（用途の再説明、動画の撮り直し、プライバシーポリシーの文言修正）。#1963 で対応する
- 通過したら、同意画面から「未確認のアプリ」警告が消え、100 ユーザーの上限が外れる。**実際に接続して同意画面を見て確認する**（Console のステータス表示だけを根拠にしない）
- 通過後に scope を増やす・アプリ名やロゴを変える・OAuth client を作り直すと再審査になる。その時は本ファイルを更新して使い回す

## プライバシーポリシーに追加する記述

ブロッカー 1 を閉じるための素案。**本ファイルでは修正しない**（#1963 の scope 外）。別 issue で `apps/web` に反映する。

反映先は 3 箇所。既存の `aiFeatures` 節がそのまま先行事例になる。

1. `apps/web/src/app/[locale]/(marketing)/legal/_components/legal-standard-document.tsx` の節レジストリに `googleCalendar` を追加する
2. `apps/web/content/legal/en/privacy.mdx` に英語の節を追加する
3. `apps/web/content/legal/ja/privacy.mdx` に日本語の節を追加する

英語の素案（実装の事実に合わせてある。実装が変わったら文も直す）:

> **Google Calendar Integration**
>
> If you choose to connect a Google account, Dayopt reads your calendars so that
> you can plan your day around the commitments you already have. This is optional
> and one-way: Dayopt never creates, modifies, or deletes anything in your Google
> Calendar.
>
> - **What we access**: the email address and account identifier of the Google
>   account you connect, the list of your calendars, so you can choose which ones
>   to import, and the events on the calendars you select.
> - **The connected account**: we store the account's email address and its stable
>   Google account identifier. We show you the email address so you can tell your
>   connected accounts apart, and we use it to suggest the right account if you
>   ever need to reconnect. We use the account identifier to confirm that a
>   reconnection is for the same account you connected originally. Both are deleted
>   when you disconnect the account.
> - **What we store**: for each imported event, only its identifier, title,
>   description, and start and end times, whether it is still active or has been
>   cancelled, together with the identifier and name of the calendar it came from. For a calendar someone shared with you, that
>   calendar identifier may be the sharing account's email address. Google's reply
>   contains more than this, but we discard everything else as we read it:
>   attendees, guest email addresses, locations, conferencing links, and
>   attachments are never used, never stored, and never written to our logs.
> - **Your calendar selection**: separately from the events, we store which
>   calendars you chose — each one's Google identifier and name — along with a sync
>   token from Google that lets the next sync fetch only what changed. We store this
>   as soon as you choose, so it exists even if a calendar turns out to have no
>   events we import. It is deleted when you deselect the calendar, disconnect the
>   account, or delete your Dayopt account.
> - **How much we read**: the 90 days before and after now. Most syncs only ask
>   Google what has changed since the last one; about once a day we re-read the
>   whole window, so the range keeps up with the current date. All-day events are
>   not imported.
> - **How we use it**: only to show you those events inside your own Dayopt
>   timeline. Imported events are visible only to you, and we never share them with
>   anyone else unless you set up a way for us to. Dayopt has features that send
>   your own entries outward at your request — granting another application
>   permission to read your entries, or turning on a calendar feed you subscribe to
>   from another calendar app. If you have built an entry from an imported event, it
>   travels over whichever of those you have switched on. Each one is something you
>   turn on yourself and can turn off again; we do not send your data anywhere you
>   have not set up.
> - **How it is protected**: the credentials that let Dayopt read your calendar are
>   encrypted before they are stored.
> - **How to stop it**: disconnect the account at any time from Settings. We ask
>   Google to revoke our access, and we delete the stored credentials, the
>   connected account's email address and identifier, and every imported event you
>   have not built on. If Google had just issued us a replacement key, that
>   replacement stays in an internal queue, encrypted, for up to 24 hours so that we
>   can revoke it as well; it goes as soon as that is done. If you have already turned an imported event into an entry of
>   your own, we keep both your entry and the imported event behind it, so that we
>   are not deleting part of your own history without asking.
> - **If you delete your Dayopt account**: everything above is deleted, including
>   the imported events we would otherwise have kept. For up to 90 days we keep a
>   record that the revocation happened, including the identifier of the Google
>   account it applied to, so that we can show it was carried out and notice if it
>   silently failed. That record is deleted automatically at the end of that period.
> - **Revoking from Google's side**: you can remove Dayopt's access directly from
>   your Google account's security settings at any time, without going through us.
>
> Dayopt's use of information received from Google APIs adheres to the
> [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
> including the Limited Use requirements. We do not sell this data, do not use it
> for advertising, and do not use it to train AI or machine learning models.

最後の Limited Use への明示的な言及は Google が要求する定型。**この一文を落とさない。**

日本語版は同じ内容を `docs/business/content/writing-style.md` の文体で書く。法務文書なので、他の節の語彙・敬体に合わせる。
