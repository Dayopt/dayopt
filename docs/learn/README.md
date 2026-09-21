# Dayopt Learning System

Dayopt で何かが起きた時に、**なぜ起きたか・どこを見るか・変えると何に影響するか**を自分で追跡できるようになるための教材。コードを暗記するためのものではない。AI が実装したものを検証し、設計の責任を持ち続けるための地図として使う。

## 使い方

```bash
pnpm learn
```

対話画面（`.learn/index.html`）が開く。画面マップで画面どうしの移り方を見て、操作を 1 つ選び、▶ で依頼がどのサービスのどの処理を通るかを辿る。各段の「⚡ ここで失敗させる」を押すと、画面・データ・再試行・痕跡がどうなり、どこから確認するかが出る。

同じ内容は、この下の Markdown を GitHub やエディタで読んでも追える。

## 中身

| 種類            | 場所                                     | 答える問い                                           |
| --------------- | ---------------------------------------- | ---------------------------------------------------- |
| 画面マップ      | [system/screens.md](system/screens.md)   | どの画面から、どの条件で、どこへ移るか               |
| 外部サービス    | [system/services.md](system/services.md) | どのサービスが止まると、何が止まり、何が動き続けるか |
| 経路（journey） | [journeys/](journeys/)                   | 1 つの操作が、ブラウザから DB まで何を通るか         |

経路:

- [Plan を保存](journeys/save-plan.md)
- [ログイン（MFA 含む）](journeys/login.md)
- [サインアップ → ウェルカムメール](journeys/signup.md)
- [Google Calendar 連携](journeys/google-calendar.md)
- [merge → 本番公開](journeys/deploy.md)

## 正本と生成物

- 各 .md の末尾にある `json learn:*` の block が正本。説明文と図（`learn:generated` の範囲）と対話画面は、そこから生成する
- 直す時は JSON を直し、`pnpm learn:generate` で説明文と図を作り直す。生成範囲を手で書き換えない
- コードやテストへの参照は、行番号ではなく `path` + `find`（そのファイルに含まれる文字列）で書く。`pnpm docs:check` が「ファイルが在り、文字列を含む」ことを検査する。コードを動かしたら `find` を追従させる
- 検査は参照の実在までで、説明の正しさは保証しない。コードと食い違いを見つけたら正本の JSON を直す
