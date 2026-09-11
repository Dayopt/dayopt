# Supabase API keys の移行

[#2517](https://github.com/Dayopt/dayopt/issues/2517) のコード準備と運用切替を分離する。以下は移行契約であり、外部設定の変更済み・本番稼働確認済みという記録ではない。

## 参照の棚卸し

| 経路                                     | 正規の入力                                                                                                                 | 互換性・検証境界                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Browser / SSR / middleware / tRPC        | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                                                                                     | SDK に渡す。ユーザー session / RLS は維持                                                             |
| MCP / OAuth / health / calendar 管理処理 | `SUPABASE_SECRET_KEY`                                                                                                      | service_role の権限は変わらない。キー更新だけではテナント分離を強化しない                             |
| password 再認証                          | `SUPABASE_SECRET_KEY`                                                                                                      | 呼び出しごとの client・rate limit・canary を維持。CAPTCHA 有効の hosted 検証は別途必要                |
| Preview OAuth identity                   | URL と認証付き identity RPC                                                                                                | opaque key を JWT decode しない。URL の project ref と DB が返す identity 全体を照合                  |
| Send Auth Email Edge Function            | `SUPABASE_SECRET_KEYS.default`（専用 `SUPABASE_SECRET_KEY` があれば優先）                                                  | managed default を明示選択。不正な modern 設定を旧キーで隠さない。署名検証・`verify_jwt=false` は維持 |
| local 開発 / CI / integration            | CLI の `PUBLISHABLE_KEY` / `SECRET_KEY` を優先し、旧CLIでは `ANON_KEY` / `SERVICE_ROLE_KEY` を上記の新しい環境変数名へ写す | CLI の legacy JWT は local 互換入力。hosted 新キーの実測証拠にはならない                              |
| 管理者 runbook                           | `SUPABASE_SECRET_KEY`                                                                                                      | curl は modern key を apikey に設定。local legacy JWT のときだけ Bearer も追加                        |
| schema / 1Password template / build gate | 上記の新しい環境変数名                                                                                                     | template 更新は vault / Vercel の更新ではない。実ファイル・実値は自動変更しない                       |

Edge の旧 `SUPABASE_SERVICE_ROLE_KEY` は loopback URL と local Docker の正確な `http://kong:8000` に限定する。hosted で modern key が取得できなければ locale の既存 English fallback になる。メール署名検証を省略する経路は追加しない。

旧名は漏えい検査、agent vault への production credential 複製禁止、過去の作業記録、integration が管理する未使用キーの例外に残す。アプリの旧環境変数依存の再導入は `scripts/__tests__/supabase-api-key-contract.test.ts` で検出する。

## 切替手順と停止条件

1. Preview の URL と新キーが同じ専用 Supabase branch を指すことを確認する。integration が管理する Preview 値へ production の値を上書きしない。新しい変数名が無い場合は配備を止める。
2. Production の既存 integration-managed modern keys と `human/supabase` 台帳の所有関係を整理する。新しい2フィールドを正本に反映し、Vercel replica と一致させる。既存 legacy field はrollback完了まで保持し、先に削除しない。`replica:check` の成功は値の一致やキーの有効性を証明しない。
3. 隔離された Preview で login / refresh / SSR、管理 API、CAPTCHA 有効時の password 再認証、MCP OAuth 交換・read/write・別ユーザー拒否、health identity を確認する。誤った project key と欠落設定が拒否されることも確認する。テスト用ユーザー・データを限定し、メール送信先も管理下に置く。
4. Edge の managed default を確認してから Preview 配備する。日本語 locale lookup、署名不正拒否、署名付き hook のメール送信を確認する。Node の resolver テストを Deno / hosted gateway の実測と同一視しない。
5. Preview の証拠をレビュー後、別の明示指示で Production を切り替える。公開キーはビルドへ埋め込まれるため再ビルドが必要。失敗時は旧配備と保持済み旧設定へ戻す。キーを無効化する前ならこのrollbackが可能。
6. 公式移行手順には legacy key の自動利用表示は無いと明記されている。Dashboard の last-used indicator を完了条件にせず、古いブラウザ配信物、外部クライアント、cron、Edge、runbook の設定と実行記録から legacy 利用が無いことを確認する。観測期間と対象を記録し、別の明示指示で旧キーを無効化する。コード検索ゼロだけでは無効化しない。

このPRの隔離テストは本番接続・設定変更・旧キー無効化を行わない。hosted gateway、CAPTCHA、Edge runtime、実際の replica 一致と legacy 利用ゼロは運用切替時の検証として残す。issue はその完了まで閉じない。

## 一次資料

- [Supabase: Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Supabase: API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase: Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- 再認証の詳細な保証境界は [Auth仕様](../product/specs/auth.md) を参照。

CLI 2.109.1 の local `status -o json` で、新旧4キー名と loopback API URL の存在を確認済み（実値は表示しない）。integration test の既定JWT fixtureは旧CLI互換の検証として残す。
