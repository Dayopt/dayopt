---
name: routing
description: 非 trivial な作業の成功条件・実行方法・モデル選択・委譲範囲を決める時、または前提の不一致で進め方を見直す時に使う。単独完遂を既定とし、独立した大量調査だけ委譲を比較する。手順が確定した小修正では不要。
---

# Routing

通常開発は ChatGPT Chat + Codex で完結する。協働原則の正本は `AGENTS.md`。ここでは実行方法とモデル選択を扱う。

## When to Use

- 非 trivial な作業の成功条件、対象範囲、検証方法を決める時
- モデル選択や独立した大量調査の委譲を検討する時
- 前提と実測の不一致、証拠が増えない失敗から進め方を見直す時

## When NOT to Use

- 手順が確定した小修正や既存パターンへの追従
- Issue の起票・割り当て・状態管理（`dispatch` skill の領域）
- 独立 PR レビュー（`pr-cross-review` skill の領域）

## 手順

1. **成功条件を固定する**。ユーザーが確認できる結果、対象範囲、検証方法、外部変更の有無を短く書く。Issue / PR があればそこに、なければ作業報告に残す。
2. 不要な作業をなくし、検索・集計・差分・検査は既存 script / CLI で閉じる。必要な一次情報だけ読む。
3. 同じ主担当で調査・判断・実装・検証・修正を進める。工程の変化だけでは handoff しない。
4. 独立した大量調査だけ、下記の委譲条件で採算を比較する。モデル名や agent 数を目的にしない。
5. 失敗時は情報不足・環境不備・仕様の曖昧さ・能力不足を切り分ける。安いモデルで同じ失敗を重ねることを節約と扱わない。停止境界は `AGENTS.md` に従う。

## Level 0 を入口にする

非自明な Issue / PR は、実装・レビューの前に `pnpm ctx <number> --reuse-brief-l1` を実行し、Issue / PR の要求、関連ファイル、既存判断、検査状態、候補 Skill と、snapshotが一致するBrief内のL1候補を確認する。この読取コマンドはJev APIを呼ばない。L1が無い・古い・取得できない場合はその状態を明記してL0と一次資料で続ける。出力が古い、欠けている、または取得できないと分かった情報だけ補い、確認済みの事実を別コマンドで重ねて集めない。

環境・hook・toolchain の状態確認が作業に必要な場合は `pnpm agent:preflight` を使う。architecture / API / MCP / DB の構造調査は、まず生成済みの [`docs/engineering/architecture.md`](../../../docs/engineering/architecture.md) と関連 map / contract docs を確認し、具体的な不足だけソースコードを探索する。

## 高影響変更の spec-first

auth / RLS / service role、billing / webhook、migration、data model、公開 API / MCP / OAuth / 外部 provider 契約、複数 feature の architecture、不可逆操作に触れる場合は、実装前に [`AI開発標準ループ`](../../../docs/operations/ai-development-loop.md) §高影響変更の spec-first を適用する。Issue / PR があればそこに、なければ作業報告に spec を残し、実装・既存契約・test と照合してから凍結する。Issue / PR を後から作った場合は転記して以後の正本にする。実装後は固定した条件へ照合する。これは production mutation や release の許可ではない。

既知の狭い修正や既存パターンへの追従でも、高影響条件に該当する場合は spec-first を適用する。高影響条件に該当しない場合は、不要な spec 凍結を追加しない。

## モデル選択

難しさ・影響・検証可能性で初期選択する。具体名は運用上の目安であり、可用性や能力の保証ではない。

| 作業                                                                        | 初期候補                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| 検索・定型変換・集計・既存検査など結果が機械的に決まる                      | script / 通常 tool                                    |
| runtime で read-only と repository scope を機械強制できる大量の読み取り調査 | Luna（`gpt-6-luna`、現在は経路なし）                  |
| 狭い範囲で正解が明確、機械的に検証できる                                    | GPT-6 Luna（今回の docs / 狭い bug / Story 評価範囲） |
| #2892 の通常 L2 レーン（許可された変更を同一担当で完遂）                    | GPT-6 Luna / Codex（運用上の候補。評価外は未検証）    |
| 未決の前提・契約・設計・scope の裁定                                        | GPT-6 Sol（L3 の助言。実装・承認を引き取らない）      |
| script / API / test で足りない実画面・操作・サービス横断の確認              | GPT-6 Astra（依頼範囲を限定した任意の支援）           |

2026-09-24 の #2889 では、GPT-6 Luna / Sol を既存の docs・bug・story・risk 各ケースで medium、各1回評価した。両モデルとも4件の受け入れ条件と scope discipline を通過した。公式 API Standard の短文脈単価で計算した API 相当額は Luna が合計 $0.01555748、Sol が $0.38721960。これは Codex の実利用料ではなく、単一試行の観測である。CLI は旧比較と異なり、集計 token から API の個々の長文脈請求区分も復元できない。Luna は評価済みの狭い docs / 再現可能な bug / Story で低コスト候補とし、Sol がより広い実装で劣るとは推定しない。4試行の結果と限界は [#2889 の評価記録](../../../docs/operations/ai-harness-audit-2889.md) を参照する。

毎回、軽量 → Sol → Astra と順番に試さない。理解済みの担当を切り替える再理解コストも含める。実測が不足する領域の表は暫定のままにする。

`#2892` の L2/L3 は実装担当と裁定担当の運用上の役割で、能力や権限を定義しない。#2889 が測ったのは docs・bug・story・risk 各1回だけであり、Luna の広い実装適性を示す根拠ではない。測定済みの狭い範囲を越える L2 配分は未検証の運用試行として扱い、性能改善を主張しない。model / reasoning / tool の利用可否は実行面で確認する。

JevのL1は、Issueの読み順を助ける関連度・分類・出典付き候補として日常の作業で使う。品質評価を利用開始の条件にせず、通常の修正や指摘から中長期で改善する。L1はshadow助言であり、Issue本文や必須条件の代わりにならず、候補外の資料を無関係とみなさない。dispatch担当は `pnpm ctx <N> --post` でL1入りBriefを作り、L2担当は `pnpm ctx <N> --reuse-brief-l1` で同じsnapshotのL1を読む。`routing.level` の L2 / L3 はそれぞれ通常実装 / 不変条件・権限・設計判断の分類で、#2892 のモデル名による役割とも別である。`preparation: L1` は追加の意味整理を同じ主担当が担うという助言であり、別agent起動やコード変更の自動許可ではない。`ready` は入力項目の存在確認だけで、実装・ラベル・merge の許可ではない。

通常の test / 型検査失敗や不足資料・環境の復旧は L2 / L0 で切り分ける。Issue の前提と実測が矛盾する、未決の契約・設計・scope 判断がある場合は依存作業を止めて L3 に問いを渡し、返答の ID・対象 SHA・状態を確認して同じ L2 担当が再開する。production・削除・実課金・不可逆変更の明示承認は人間が行う。

Issue briefを利用する担当Codex sessionは、Issue本文と信頼できる最新 `ctx-brief` コメントを自分の入力として明示取得し、Issue番号・snapshotの一致を確認する。Issue本文が要求の正本であり、コメントが存在するだけではsessionが取得した証拠にならない。

### Codex Cloud へ L1 を渡す

Cloud の L2 担当は Gateway key を持たず、Jev API を呼ばない。dispatch 前に、key を1Passwordから注入できる担当が `pnpm ctx <N> --post` で日常利用するL1候補入りBriefを作成・更新する。Cloud の担当は `pnpm ctx <N> --reuse-brief-l1` を実行し、Issue本文・関連資料・コメントを再収集した L0 とともに、Brief 内の候補を取得する。

再利用は trusted `ctx-brief` の machine metadata が Issue 番号・URL・入力snapshot・公開 HEAD SHA のすべてと一致し、投稿者が現在の `gh` 認証ユーザーと一致した時だけ行う。別ユーザーのBrief、古い Brief、旧形式の Brief、GitHub API 未認証・取得失敗では L1 を未取得にし、L0とIssue本文から続行する。Cloud task に `--post` を付けない。Cloud 側は repository access と `gh` の GitHub API 読み取りが必要で、ネットワークが使えない時にL1が届いた扱いにしない。

評価モデル Jev（`pnpm jev:*`）は、この選択を置き換えない。文章しか入力が無く答えが有限集合の判定へ意味的な特徴を足す層で、注釈は候補の提示までに留まり、権限・必須レビュー・merge には繋がない。**決定的に分かることは Jev へ聞かない**（実測で負けた 4 判定と、pack を足す手順は [jev.md](../../../docs/operations/jev.md)）。

## 委譲する場合だけ

初期対象は repository-wide search、関連実装・テストの discovery、大量ログの分類など read-only の大量調査。主作業から独立し、短く検証可能な成果が返り、親の照合まで含めて利益がある場合に限る。architecture・debugging の判断、認可・migration・時間不変条件、重要な編集は主担当が持つ。

read-only と repository scope を runtime で同時に機械強制できる adapter は現在ないため、大量の読み取り調査も委譲せず主担当が行う。将来、両方の境界を実測できる adapter が追加された場合だけ、Codex は Luna（`gpt-6-luna`）、Claude は Haiku 相当を候補にする。現行 native `spawn_agent` / `Agent` は実際の入力に read-only / write を区別する型がないため、read-only を含む判別不能な経路として使わない。runtime が別名の typed write / browser tool を提供した時だけ、User が明示した非重複 scope と既存の authority 契約に従って扱う。専用 security harness のモデル選択はこの読み取り調査の指定対象ではない。

渡すものは成功条件、読む範囲、既知の制約、検証方法、禁止操作。返却は「確認した範囲／事実／file・symbol・location／未確認範囲／不足情報」に絞る。prompt の read-only 指示は security boundary ではないため、runtime の権限も合わせる。専用 security harness のレビューはこの通常調査とは別契約で行う。

別 session への永続 handoff が実際に必要な時だけ [handoff 手順](references/handoff.md) を読む。単独完遂時は pack や説明資料を作らない。

## ChatGPT Chat と Codex

Chat は product / UX の論点、research、前提の反証、仕様・Issue 整理を扱う。Codex は repo に基づく設計、実装、検証、修正、PR を担う。Chat で具体的実装計画を作り込み、Codex で作り直す二重作業を避ける。承認済み目的・仕様・リスク境界内の技術判断は毎回 Chat に戻さない。

実際に受け渡す時だけ [Chat 連携手順](../../../docs/operations/chat-handoff.md) を読む。通常の往復、Deep Research の起動、利用枠はそれぞれ実測し、画面のコピー待ちを必須にしない。

## 効果の回収

実作業で分類、実際の model / reasoning、委譲有無、取得できる利用量、総時間、追加指示、修正 round、検証失敗、独立レビューの P1 / P2、受け入れ条件を記録する。委譲時は親の引き渡し・照合も含める。

同品質以上で総利用量・時間・人間介入のいずれかが改善したか判断する。`pnpm ai:usage` の Codex session telemetry は未収集なので 0 と比較せず、実行単位の記録を使う。取得できない値は未計測。改善がなければ委譲を増やさず単独 Codex へ戻す。
