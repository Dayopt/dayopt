---
status: current
last_verified: 2026-09-27
code:
  - packages/components/src/identity/logo.tsx
  - packages/components/src/identity/logo-data.ts
  - scripts/generate-brand-assets.ts
---

# Dayopt ブランド / Approved F

2026-09-27 に F を正式採用。B・03 は検討履歴として保存し、新規利用しない。

## 正本と配布

- 視覚上の正本: [Figma / Approved F](https://www.figma.com/design/eAthKm7adblXS1TzeSkScx/Dayopt-Brand---Logo?node-id=7-288)
- アプリアイコン: [Figma / App Icon Light 75%](https://www.figma.com/design/eAthKm7adblXS1TzeSkScx/Dayopt-Brand---Logo?node-id=13-2)（[通常版1024pxマスター](https://www.figma.com/design/eAthKm7adblXS1TzeSkScx/Dayopt-Brand---Logo?node-id=13-60)・[マスク用60%マスター](https://www.figma.com/design/eAthKm7adblXS1TzeSkScx/Dayopt-Brand---Logo?node-id=13-66)）
- 書き出しボード: [Figma / Download](https://www.figma.com/design/eAthKm7adblXS1TzeSkScx/Dayopt-Brand---Logo?node-id=10-2)
- Webのfavicon・SVG icon・Apple icon: `apps/web/src/app/favicon.ico`、`icon.svg`、`apple-icon.png`。Next.jsのファイル規約からhead要素を生成する。
- コード共通データ: `packages/components/src/identity/logo-data.ts`
- Figmaから直接書き出した採用ロックアップ: `assets/brand/figma-approved-lockup.svg`
- 配布先: Web / Product 両方の `public/brand/`。公開後は `/brand/dayopt-brand-F.zip` で一括取得できる。
- `public/brand/` と配布ZIPの `mark.svg`、`wordmark.svg`、`lockup.svg` は、ライト背景向けPrimary色の短縮名。ダーク背景では `*-reverse.svg` を使う。
- Eagle: Dayopt → Brand → Logo → F — Approved 2026-09-27。

| 用途                           | ファイル                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| Webヘッダー、フッター          | `dayopt-wordmark-primary.svg` / `dayopt-wordmark-reverse.svg`         |
| 認証画面                       | `dayopt-lockup-primary.svg` / `dayopt-lockup-reverse.svg`             |
| 正方形のシンボル枠             | `dayopt-symbol-primary.svg` / `dayopt-symbol-reverse.svg`             |
| 見た目の外接矩形に合わせる配置 | `dayopt-symbol-tight-primary.svg` / `dayopt-symbol-tight-reverse.svg` |
| インストール用アイコン         | `dayopt-app-icon.svg`、192 / 512 / 1024 PNG                           |
| マスク用アイコン               | `dayopt-app-icon-maskable.svg`、192 / 512 PNG                         |
| 角丸の見た目確認               | `dayopt-app-icon-rounded-preview.svg`                                 |

SVGは透明背景、穴は実際に抜いたベクター。ロックアップとワードマークは文字をアウトライン化済み。フォントのインストールやWebフォント読み込みは不要。PNGは透過に対応する。アプリアイコンは例外として不透明な背景を持つ。

### OG画像

- `og-image-light.png` / `og-image-dark.png` は 1200×630px。OGP向けの背景とロックアップを組み合わせた画像で、SVG原稿も `public/brand/` に同梱する。
- Light は白地に Primary ロゴ、Dark は Primary 地に白ロゴ。
- 既存の `/og-image.png` は Dark 版を指し、URL互換を維持する。Web / Product の静的ブランド配布先には Light / Dark の両方を置く。
- SNSのOGP取得側は閲覧者のOSやサイト表示テーマを知らないため、自動切替できない。ページの `og:image` に採用したいテーマの画像URLを明示する。

## 構造

100×100座標系で実形状99×90を中央配置する。

| 要素         |    x |   y |  幅 | 高さ | 角半径（左 / 右） |
| ------------ | ---: | --: | --: | ---: | ----------------- |
| Plan外形     |  0.5 |   5 |  47 |   74 | 11 / 9            |
| Plan内側の穴 |  7.5 |  12 |  33 |   60 | 4 / 2             |
| Log          | 52.5 |  11 |  47 |   84 | 9 / 11            |

Planは輪郭、Logは塗り。間隔5、右上端は6下がり、下端差16。左右の外形幅は等しく、塗りによって記録側に重みを置く。初期検討時の破線・重なり・15%オフセットは採用版Fには適用しない。

文字はInter Semi Bold、字間−3.5%。Figmaで確定したパスをそのまま利用する。本文フォントをInterへ変更する仕様ではない。付属の `Inter-LICENSE.txt` は字体のライセンス情報。

## 色・余白・サイズ

- Primary: `#26251F`。ライト背景で使用する。
- Reverse: `#FFFFFF`。ダーク背景で使用する。形状は同じ。
- アプリアイコンはライト版のみを使用する。背景 `#FFFFFF`、マーク `#26251F`。端末の表示モードによって切り替えない。favicon、Apple/PWAアイコンも同じ配色にする。
- Reactの `Logo` は専用 `brand-ink` トークンでテーマに追従する。
- シンボル周囲は原則14単位以上（輪郭厚7の2倍）を確保する。これは外部コンテンツとの余白であり、マークと文字の間隔には加えない。
- シンボルは16px以上、横組みは高さ20px以上を目安とする。Web faviconは背景付きSVGを使い、Next.jsのファイル規約でICOとApple iconも指定する。PWA用アイコンは既存の `public/icons/` とmanifestで管理する。
- 通常のアプリアイコン、Apple用、faviconは正方形の75%幅をマークに使用する。PWAのマスク用原稿は60%幅を維持し、背景を四隅まで敷く。いずれも見た目の中央から1%左へ補正する。OS用原稿には角丸を二重に付けない。
- 引き伸ばし、回転、左右の独立拡縮、穴の白塗り化、影、グラデーション、追加記号、文字の打ち直しをしない。

## 実装と再生成

```tsx
import { Logo } from '@dayopt/components';

<Logo size="md" />
<Logo variant="mark" size="sm" />
```

`label` はアクセシブル名。ロゴの表示文字を変更するAPIではない。OG画像は `@dayopt/components/brand` の同じパスを使う。

```sh
pnpm exec tsx scripts/generate-brand-assets.ts
```

生成スクリプトはSVG、PNG、favicon ICO、Apple/PWAアイコン、Light / Dark のOG画像を両アプリへ出力し、Web用のfavicon・SVG icon・Apple iconをNext.jsのファイル規約へ配置する。配布ZIPは `public/brand` 内の素材・本書・ライセンスをまとめる。形状変更時はFigmaの承認を先に更新し、共通データと配布物を同時に更新する。生成済みPNGやコピー先のSVGを個別に修正しない。

本変更はロゴと配置の更新。UIの本文書体、操作色、認証処理は既存仕様を維持する。
