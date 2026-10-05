# @dayopt/config

> 責務境界の全体像: [docs/engineering/architecture.md](../../docs/engineering/architecture.md)

アプリ横断で使う**public-safe な定数の source of truth**を置く package。
クライアントに露出しても安全な、全環境で同一の静的な公開値だけを持つ。

> secret・env 依存値・app 固有定数・i18n 文言は入れない。責務を小さく保つための package。

## 構造

<!-- docs-live:files:start -->

正本は [packages/config/src/](src)。現在の一覧は `pnpm docs:read packages/config/README.md` で生成して読む。

<!-- docs-live:files:end -->

consumer は常に `@dayopt/config`（barrel）から import する。内部ファイル分割は consumer に影響しない。

## 入れる / 入れない

**入れる**: 全環境で同一・ビルド時に静的に埋め込める・クライアント露出して安全な公開値。

- ブランド名 / team 名（`dayoptBrand`）
- 公開 domain / URL（`dayoptDomains` / `dayoptUrls`）
- 公開 email / SNS リンク（`dayoptContact` / `dayoptBrand` の X・GitHub・YouTube）
- locale 定義（`SUPPORTED_LOCALES` / `DEFAULT_LOCALE` / `LOCALE_PREFIX` / `Locale`）
- 上記から導出する純粋ユーティリティ（`createDayoptUrl`）

**入れない**:

| 入れないもの                                    | 正しい置き場                             |
| ----------------------------------------------- | ---------------------------------------- |
| secret / API key / token                        | env（`apps/*/src/env.ts` 等で Zod 検証） |
| env 依存値（`NEXT_PUBLIC_*` / `VERCEL_URL` 等） | env（環境ごとに変わる）                  |
| app 固有の定数（settings カテゴリ等）           | 各 app（`apps/*`）                       |
| i18n の文言 / 翻訳                              | `apps/*/messages`                        |
| design token / CSS variables                    | `@dayopt/foundations`                    |
| React component                                 | `@dayopt/components`                     |

## env vs config の境界

| 判定       | 条件                                                   | 例                                        |
| ---------- | ------------------------------------------------------ | ----------------------------------------- |
| **config** | 全環境で同一・ビルド時に静的に埋め込める・公開して安全 | brand 名 / 公開 URL / 公開 email / locale |
| **env**    | 環境ごとに変わる・secret を含む・runtime に決まる      | API key / secret key / `VERCEL_URL`       |

## Boundary（依存方向）

`@dayopt/config` は zero-dependency。**何も import しない**（最下層）。

```
apps/product ─┐
apps/web ─────┴──> @dayopt/config
```

NG: `@dayopt/config` → `apps/*` / `@dayopt/foundations` / `@dayopt/components` / `next/*` / `react`

> Future: eslint（`no-restricted-imports`）での逆依存禁止の強制は、packages 間 boundary を
> ルール化するタイミングでまとめて導入を判断する。
