---
status: current
last_verified: 2026-08-20
code: apps/product/src/features/calendar
public_docs:
  - calendar
lp:
  - 'Calendar — day, week, and multi-day views'
---

# Calendar（カレンダー）

Plan（予定）とRecord（記録）を同じ時間軸で配置・閲覧する、Dayoptのプライマリ作業面。

## 現在の振る舞い

- Day / Week / Multi-Day（2〜7日）で、表示範囲と基準日をURLに保持する
- Multi-Dayは選択した日数を表示列数として維持し、基準日を中央に配置する。週末非表示では土日を除いたN営業日を表示する。Weekは週境界を正とする別viewで、週末非表示時は平日の5日を表示する
- Multi-Dayの前後移動は表示列数と同じN日単位とし、週末非表示ではN営業日単位で移動する。隣接する期間に同じ表示日を重複させない
- 各日カラムをPlanレーンとRecordレーンに分ける。Planは控えめなoutline、Recordは塗りで表示する。レーン幅は区間ごとに動的で、相手レーンに時間の重なるタイムブロックが無ければそのタイムブロックはフル幅表示、重なる時間帯だけ左右split（Plan 38% / Record 62%）にする。ドラッグ中のpointer→lane判定・drag ghost・選択後パレット・選択中previewもこの動的判定に揃えており、境界が見えない（相手のタイムブロックが無い）時刻ではPlan→Recordの意図しない変換は起きない
- モバイルはDay / Weekを提供する。Weekでは予定または記録を切り替えて日カラム全幅に表示し、最後に選んだ表示を端末へ保持する。既定は記録
- モバイルの検索、作成、Inspector、activity / 日時picker、振り返りpanelは[Mobile overlays](./mobile-overlays.md)のmodal性とdismiss契約に従う
- 新規作成時の保存先は`end_at > now`ならPlan、`end_at <= now`ならRecordとして自動決定し、既存Plan / Recordの編集では種別を維持する
- dragによる作成・移動・resizeは15分刻み、Inspectorの時間入力は1分刻みとする。移動・resizeは移動量だけを15分刻みにするため、10:07のタイムブロックを1コマ下げると10:22になり15分gridへ吸着しない。keyboard操作、activity filterも提供する
- `?`キーまたはSidebar右端のヘルプメニューから、現在登録されているkeyboard shortcut一覧を背景overlayなしの横長2列で開く。操作行の区切り線は表示しない。キー表記は利用中platform、説明はlocaleに合わせる
- Calendarの時間軸、card、選択 / drag preview、Diff panelの時刻表示はユーザー設定の12時間 / 24時間表記に従う。Inspectorの入力・保存値は`HH:mm`を正とする
- scroll keyはfocus中のCalendar gridだけが処理し、入力、IME、menu / dialog中はglobal shortcutを実行しない
- hour gridとday dividerは内部線としてsubtleに表示し、同じ境界を重ねて描画しない
- Diffは符号と方向を数字・iconで示し、増減そのものをsuccess / destructive色で評価しない
- 過去Planの時間も通常どおり編集できる。Recordは終了を未来へ動かす編集だけ不可
- 既存カードのdrag previewは移動先のレーンと同じカードで表示する。Planはoutline、RecordとPlan→Recordの記録化previewは塗りで区別する
- 過去PlanをRecordレーンへdragすると、drop previewの時間帯へアクティビティとメモをコピーした独立Recordを作る。元Planは変更しない
- PlanとRecordが時間的に少しでも重なる区間はactivityに関係なく左右へ分ける。詳細の「この時間帯の記録」は同じactivityで15分以上重なるRecordを表示する
- Plan / Recordカードへ予定別の差分は表示しない。予実比較は期間内のRecord合計 / 経過済みPlan合計から導出する
- 差分の正負は符号と方向iconで示し、成功・失敗を意味する色は使わない
- `panel=review` / `panel=diff`で単一の右panel slotを開く。panel UIはReview featureが所有し、Calendarは表示範囲とcompositionを所有する
- Review / Time P/Lの集計対象日はCalendarの表示日配列を正とし、週末非表示時は範囲内の土日を含めない
- Diffの対象期間はCalendarの現在viewを正とし、day / week / multi-dayの範囲をそのまま使う

## Stateの正本

- view、date、panel: URL + `CalendarNavigationContext`
- server data: tRPC + TanStack Query
- drag、filter、scroll等の一時表示状態: Calendar内のZustand store
- feature間の合成: `apps/product/src/app/**/_composition/`

実装上のdata flowと依存境界は[Engineering Architecture](../../engineering/architecture.md)、component variantはStorybookを参照する。

## ブロック検索

- 検索はCalendar内の補助導線であり、独立pageやcommand paletteにはしない。desktopはSidebar、mobileは展開したmini calendarから開き、`Cmd/Ctrl+K`でも開ける。mobileでは検索欄とキャンセルを上部に固定した全高bottom sheetを使い、結果領域だけをscrollする
- 削除されていない全期間のPlan / Recordを、activeなactivity名とメモの部分一致で検索し、activity自体は結果にしない
- 空の検索語では取得せず、結果は開始日時の新しい順に20件まで表示する。検索履歴や最近使った項目は保存しない
- 結果にはPlan / Recordの別、表示名となるactivity、メモの抜粋、日時を表示する。DB互換の`title`と内部IDは表示しない
- 結果を選ぶと対象日のCalendarへ移動し、URLで対象ブロックのInspectorを開く。検索結果内には複製などの副操作を置かない

## 関連する意思決定

- 7日表示をWeekではなく中央基準の7営業日として扱う（削除済み、git 履歴参照）
- 検索対象と表示をtag・メモに揃え、結果は対象ブロックを開く操作に限定する（削除済み、git 履歴参照）
- ADR-025: Plan / Record / 外部カレンダーミラーへの分割（削除済み、git 履歴参照）
- 時間不変原則（削除済み、git 履歴参照）
- 機能スコープ（削除済み、git 履歴参照）
