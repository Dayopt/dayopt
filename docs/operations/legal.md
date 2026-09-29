---
status: current
last_verified: 2026-08-12
---

# 規約・ポリシーの所在

Legal（利用規約・プライバシーポリシー等）の実体パスと改定記録の運用ルール。現行版の本文は複製しない。

## 現行版の参照先

現行版の本文は **アプリ内（`apps/web`）が正本**。ここでは複製せず、参照先と改定の記録場所だけを示す。

| 文書                     | 実装パス                                                   | i18n messages                                         |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| 利用規約                 | `apps/web/src/app/[locale]/(marketing)/legal/terms/`       | `apps/web/messages/{ja,en}/legal.json`                |
| プライバシーポリシー     | `apps/web/src/app/[locale]/(marketing)/legal/privacy/`     | `apps/web/messages/{ja,en}/legal.json`                |
| Cookie ポリシー          | `apps/web/src/app/[locale]/(marketing)/legal/cookies/`     | `apps/web/messages/{ja,en}/legal.json`                |
| 返金ポリシー             | `apps/web/src/app/[locale]/(marketing)/legal/refund/`      | `apps/web/messages/{ja,en}/legal.json`                |
| 特定商取引法に基づく表記 | `apps/web/src/app/[locale]/(marketing)/legal/tokushoho/`   | `apps/web/messages/{ja,en}/legal.json`                |
| セキュリティ             | `apps/web/src/app/[locale]/(marketing)/legal/security/`    | `apps/web/messages/{ja,en}/legal.json`                |
| OSS クレジット           | `apps/web/src/app/[locale]/(marketing)/legal/oss-credits/` | 生成物（`pnpm generate-licenses` 相当）。手書きしない |

## 改定の記録

利用規約・プライバシーポリシー等を改定したら、**なぜ改定したか**を `/decision` で記録する（本文の diff は git history が正本、decision には理由だけ書く）。

過去の改定理由は [決定索引](../decisions.md)と関連 Issue / PR を辿る。過去の例にある通知日数や契約前提を、現行の承認済み義務として再利用しない。

## レビュー準備・承認・公開の境界

[#2010](https://github.com/Dayopt/dayopt/issues/2010) は「人間が最終レビューできるドラフト・証拠・未決事項の準備」を完了範囲に変更した。Issue の close は法務承認や本番公開を意味しない。6ページの日英ドラフトとレビュー資料は [PR #2833](https://github.com/Dayopt/dayopt/pull/2833) にあり、この checkout に資料がなくても準備未実施とは断定しない。

最終承認と公開の要求の正本は [#2832](https://github.com/Dayopt/dayopt/issues/2832)。HUMAN-01〜10 と元の8項目の証拠、承認者による確認、明示的な公開指示、公開後の SHA・12 URL の確認をそこで扱う。未決の法務判断を agent が推測で埋めない。同意撤回 UI は [#2831](https://github.com/Dayopt/dayopt/issues/2831)、課金表記の公開順序は [課金の公開手順](billing-single-plan-rollout.md)へ。現在の承認・公開状況は各 Issue / PR で確認し、ここに状態の写しを作らない。

## このファイルに書かないこと

- 規約・ポリシーの本文コピー（アプリ側と二重管理になり drift する）
- 改定履歴の詳細diff（git log で追える）
