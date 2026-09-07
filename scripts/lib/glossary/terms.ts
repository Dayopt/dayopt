/**
 * 用語集レジストリ（正本データ）
 *
 * ここが Dayopt の語彙の source of truth。`docs/product/glossary.md` の表と
 * `pnpm copy:check` の禁止語は、どちらもこのファイルから生成・派生する。
 * 編集したら `pnpm glossary:generate` を実行して docs を再生成する。
 *
 * 判定ロジックと描画は `core.ts`。このファイルはデータだけを持つ。
 *
 * enforcement の運用:
 *   active       … messages 側の違反が 0 件で、再発を CI（copy:check:strict）が止める語
 *   migration    … 既存違反が残っている語。新規追加は禁止（警告で可視化）。2026-09-07 の
 *                  移行 PR で全語を active へ上げたため、現在この段階の語は無い
 *   context-only … 機械判定すると誤検知が上回る語。表に載せてレビューで拾う
 */

import type { GlossaryEntry, KeyNameRule } from './core.ts';

export const GLOSSARY: readonly GlossaryEntry[] = [
  // ─── UI 用語: 時間そのもの ───
  {
    id: 'timeblock',
    layer: 'ui',
    status: 'current',
    concept: 'Timeblock',
    ja: 'タイムブロック',
    en: 'Timeblock',
    usage: 'カレンダー上の時間ブロック。予定 / 記録の総称',
    code: { feature: 'timeblock', i18nNamespace: 'timeblock' },
    refs: ['decisions.md 2026-09-07'],
    forbidden: [
      {
        term: 'ブロック',
        locale: 'ja',
        enforcement: 'active',
        // 「タイムブロック」の部分文字列なので、正解語ごと違反判定されないよう
        // lookbehind で外す（旧 glossary が「カテゴリ / カテゴリー」で踏んだ形）
        pattern: '(?<!タイム)ブロック',
        // 「IP アドレスがブロックされています」は遮断の意味の同音異義。
        allowKeyPaths: ['[Ii]pBlocked'],
        reason: '総称は「タイムブロック」に統一する。単独の「ブロック」は妨害の意味とも読める',
      },
      {
        term: '箱',
        locale: 'ja',
        enforcement: 'active',
        pattern: '(?<!ゴミ)箱',
        reason: '/report だけで使われている 3 つ目の呼称。「タイムブロック」か「件」に寄せる',
      },
      {
        term: 'エントリ',
        locale: 'ja',
        enforcement: 'active',
        reason: 'ADR-025 で廃止した旧 Entry 単一モデルの呼称。Plan / Record に分割済み',
      },
      {
        term: 'タスク',
        locale: 'ja',
        enforcement: 'active',
        allowKeyPaths: ['^legal\\.', '^app\\.keywords'],
        reason:
          'GTD のタスクリスト項目と混同する。Dayopt が置くのはタスクではなく時間。法的文書と SEO keyword は据え置き',
      },
      {
        term: 'block',
        locale: 'en',
        enforcement: 'active',
        match: 'word',
        reason: 'ja「タイムブロック」に対応する en は Timeblock。単独の block は使わない',
      },
      {
        term: 'box',
        locale: 'en',
        enforcement: 'active',
        pattern: '\\bboxe?s?\\b',
        reason: '/report の 3 つ目の呼称',
      },
      {
        term: 'event',
        locale: 'en',
        enforcement: 'active',
        match: 'word',
        // 外部カレンダー連携（Google Calendar のイベント）と、Sentry の event / 法的文書は別義。
        allowKeyPaths: [
          '^calendar\\.external\\.',
          'externalEvents',
          'ghost',
          '^legal\\.',
          'googleCalendar',
        ],
        allowConceptIds: ['external-event'],
        reason: 'event は外部カレンダー由来の予定を指す語。Dayopt 自身の時間には使わない',
      },
      {
        term: 'entry',
        locale: 'en',
        enforcement: 'active',
        pattern: '\\b(entry|entries)\\b',
        allowKeyPaths: [
          '^oauth\\.consent\\.scope\\.',
          '^settings\\.integrations\\.mcpConnections\\.scopes\\.',
        ],
        reason: '旧 Entry モデルの呼称。OAuth scope 名 read:entries は外部契約なので据え置き',
      },
      {
        term: 'task',
        locale: 'en',
        enforcement: 'active',
        match: 'word',
        allowKeyPaths: ['^legal\\.', '^app\\.keywords'],
        reason: 'ja「タスク」と同じ理由',
      },
    ],
  },
  {
    id: 'plan',
    layer: 'ui',
    status: 'current',
    concept: 'Plan',
    ja: '予定',
    en: 'Plan',
    usage: 'これからやる時間の宣言。時間軸のどこにでも置ける独立エンティティ',
    code: { identifiers: ['PlanEvent'], feature: 'timeblock' },
    db: ['plans'],
    forbidden: [
      {
        term: '計画',
        locale: 'ja',
        enforcement: 'context-only',
        reason:
          '名詞の「計画」は使わないが、動詞「計画する」「計画どおり」は正当。部分一致では割れないためレビューで拾う',
      },
    ],
  },
  {
    id: 'record',
    layer: 'ui',
    status: 'current',
    concept: 'Record',
    ja: '記録',
    en: 'Record',
    usage: '実際に使った時間。1 予定に複数紐づく（1:N）。未来には終われない',
    code: { identifiers: ['RecordEvent'], feature: 'timeblock' },
    db: ['records'],
    forbidden: [
      {
        term: '実績',
        locale: 'ja',
        enforcement: 'active',
        reason:
          'UI では「記録」に統一する。「実績」は評価の含みがあり、判定せず数字で示すという原則に反する',
      },
    ],
  },
  {
    id: 'timebox',
    layer: 'ui',
    status: 'current',
    concept: 'Timeboxing',
    ja: 'タイムボックス',
    en: 'Timebox',
    usage: '時間を区切って作業する手法そのもの。説明文脈で使う（個々の時間は「タイムブロック」）',
  },

  // ─── UI 用語: 分類 ───
  {
    id: 'activity',
    layer: 'ui',
    status: 'current',
    concept: 'Activity',
    ja: 'アクティビティ',
    en: 'Activity',
    usage: '予定と記録の単位。最も具体的な分類で、無限に増えてよい',
    code: { feature: 'activities', i18nNamespace: 'activities' },
    db: ['activities'],
    refs: ['#2162'],
    forbidden: [
      {
        term: 'タグ',
        locale: 'ja',
        enforcement: 'active',
        reason:
          '所属（集計が合う軸）と横断参照（分析）を 1 語に混ぜており集計が濁る。#2162 でアクティビティ / カテゴリー / セグメントへ全置換',
      },
      {
        term: 'ラベル',
        locale: 'ja',
        enforcement: 'active',
        // a11y の aria-label は「ラベル」という語を UI 文言側に出さないので除外は付けない。
        // 除外を足すと active ルールに未検証の抜け道を作ることになる。
        reason: '1 対象に複数付けられる印象を与える。1 タイムブロック 1 アクティビティ',
      },
    ],
  },
  {
    id: 'category',
    layer: 'ui',
    status: 'current',
    concept: 'Category',
    ja: 'カテゴリー',
    en: 'Category',
    usage: '所属の主軸。1 アクティビティは最大 1 カテゴリー。色とアイコンを持つ',
    db: ['categories'],
    refs: ['#2162'],
  },
  {
    id: 'segment',
    layer: 'ui',
    status: 'current',
    concept: 'Segment',
    ja: 'セグメント',
    en: 'Segment',
    usage: '分析用の保存されたクエリ。所属ではなく横断参照なので合計比率を持たない',
    code: { feature: 'review' },
    db: ['segments', 'segment_activities'],
    refs: ['#2162'],
    forbidden: [
      {
        term: '束',
        locale: 'ja',
        enforcement: 'active',
        // 「約束」を巻き込まない
        pattern: '(?<!約)束',
        reason: '/report のモバイル chip だけで使われている別名。「セグメント」に一本化する',
      },
      {
        term: 'レンズ',
        locale: 'ja',
        enforcement: 'active',
        reason: '同上。spec と UI で「レンズ」「束」「セグメント」が三つ巴になっていた',
      },
      {
        term: 'lens',
        locale: 'en',
        enforcement: 'active',
        pattern: '\\b(lens|lenses)\\b',
        reason: 'ja「レンズ」と同じ理由',
      },
    ],
  },
  {
    id: 'uncategorized',
    layer: 'ui',
    status: 'current',
    concept: 'Uncategorized',
    ja: '未分類',
    en: 'Uncategorized',
    usage: 'どのカテゴリーにも入っていない時間の残余バケット',
    code: { identifiers: ['UNCATEGORIZED_KEY'] },
  },
  {
    id: 'plan-template',
    layer: 'ui',
    status: 'current',
    concept: 'Plan template',
    ja: 'テンプレート',
    en: 'Template',
    usage: '1 日の予定の並びを保存して別の日へ適用する仕組み',
    code: { identifiers: ['planTemplates'], feature: 'timeblock' },
    db: ['plan_templates', 'plan_template_blocks'],
    refs: ['decisions.md 2026-09-07'],
    forbidden: [
      {
        term: '型',
        locale: 'ja',
        enforcement: 'active',
        reason:
          '同じ namespace 内で「テンプレート」と割れていた。DB / en / サイドバー見出しに合わせて「テンプレート」へ寄せる',
      },
    ],
  },

  // ─── UI 用語: 画面と操作 ───
  {
    id: 'review',
    layer: 'ui',
    status: 'current',
    concept: 'Review',
    ja: '振り返り',
    en: 'Review',
    usage: 'ページ名・機能名。route は /report、i18n namespace も report',
    code: { feature: 'review', i18nNamespace: 'report' },
    note: 'feature dir / tRPC router は review、route と i18n namespace は report で割れている（コード識別子の整理は別 issue）',
    forbidden: [
      {
        term: 'レビュー',
        locale: 'ja',
        enforcement: 'active',
        allowIfValueIncludes: [
          'プレビュー',
          '法的レビュー',
          'レビューを受ける',
          'レビューインサイト',
        ],
        reason: 'コードレビューや評価を連想させる。ページ名は「振り返り」',
      },
    ],
  },
  {
    id: 'inspector',
    layer: 'ui',
    status: 'current',
    concept: 'Inspector',
    ja: 'インスペクタ',
    en: 'Inspector',
    usage: 'タイムブロックをクリックした時に開く詳細パネル',
    code: { identifiers: ['DockedInspectorPanel'], feature: 'timeblock' },
  },
  {
    id: 'draft',
    layer: 'ui',
    status: 'current',
    concept: 'Draft',
    ja: 'ドラフト',
    en: 'Draft',
    usage: '未保存のプレビュー状態のタイムブロック。ドラッグ中・複製直後など',
    code: { identifiers: ['isDraft', 'DraftTimeblock'] },
  },
  {
    id: 'archive',
    layer: 'ui',
    status: 'current',
    concept: 'Archive',
    ja: 'アーカイブ',
    en: 'Archive',
    usage: 'アクティビティ / カテゴリーを一覧から隠す。過去の記録は残る（削除ではない）',
    code: { identifiers: ['archiveActivity'] },
    db: ['activities.archived_at', 'categories.archived_at'],
  },
  {
    id: 'trash',
    layer: 'ui',
    status: 'current',
    concept: 'Trash',
    ja: 'ゴミ箱',
    en: 'Trash',
    usage: '削除したタイムブロックの soft delete 置き場。復元できる',
    code: { identifiers: ['deleted_at'] },
    db: ['plans.deleted_at', 'records.deleted_at'],
  },
  {
    id: 'confirm-day',
    layer: 'ui',
    status: 'current',
    concept: 'Confirm day',
    ja: 'この日を確定',
    en: 'Confirm day',
    usage: '過去の予定をまとめて記録へ変換する操作',
    code: { identifiers: ['confirmDay'] },
    db: ['confirm_day_plans_command_v1'],
  },
  {
    id: 'fulfillment',
    layer: 'ui',
    status: 'current',
    concept: 'Fulfillment',
    ja: '充実度',
    en: 'Fulfillment',
    usage: '記録に付ける 3 値。low = 消耗 / medium = 普通 / high = 充実',
    code: { identifiers: ["'low' | 'medium' | 'high'"] },
    db: ['records.fulfillment'],
  },
  {
    id: 'progress',
    layer: 'ui',
    status: 'current',
    concept: 'Progress',
    ja: '進捗',
    en: 'Progress',
    usage: '予定に対して記録がどこまで進んだかを数字で示す',
    forbidden: [
      {
        term: '達成',
        locale: 'ja',
        enforcement: 'active',
        reason:
          '「達成率」「達成度」は良し悪しの判定語。判定せず数字で示すという copywriting 原則に反する',
      },
    ],
  },
  {
    id: 'external-event',
    layer: 'ui',
    status: 'current',
    concept: 'External calendar event',
    ja: '外部カレンダーの予定',
    en: 'External event',
    usage: 'Google Calendar 等から同期した予定。未変換のものはゴーストとして薄く出す',
    code: { identifiers: ['ExternalCalendarEvent'], feature: 'external-calendar' },
    db: ['external_calendar_events'],
    note: '「イベント」「event」が正当に使える唯一の概念',
  },
  {
    id: 'account',
    layer: 'ui',
    status: 'current',
    concept: 'Account',
    ja: 'アカウント',
    en: 'Account',
    usage: '設定ページ名',
  },
  {
    id: 'sign-in',
    layer: 'ui',
    status: 'current',
    concept: 'Sign in',
    ja: 'サインイン',
    en: 'Sign in',
    usage: '認証アクション',
    forbidden: [
      {
        term: 'ログイン',
        locale: 'ja',
        enforcement: 'active',
        allowKeyPaths: ['^legal\\.'],
        reason: '「サインイン」に統一する。法的文書は改訂扱いになるため据え置き',
      },
      {
        term: 'log in',
        locale: 'en',
        enforcement: 'active',
        pattern: '\\blog\\s?in\\b|\\blogged\\s?in\\b|\\blogging\\s?in\\b',
        allowKeyPaths: ['^legal\\.'],
        reason: 'en 側も log in / sign in で割れている',
      },
    ],
  },
  {
    id: 'sign-out',
    layer: 'ui',
    status: 'current',
    concept: 'Sign out',
    ja: 'サインアウト',
    en: 'Sign out',
    usage: '認証解除アクション',
    forbidden: [
      {
        term: 'ログアウト',
        locale: 'ja',
        enforcement: 'active',
        allowKeyPaths: ['^legal\\.'],
        reason: '「サインアウト」に統一する',
      },
      {
        term: 'log out',
        locale: 'en',
        enforcement: 'active',
        pattern: '\\blog\\s?out\\b|\\blogged\\s?out\\b|\\blogging\\s?out\\b',
        allowKeyPaths: ['^legal\\.'],
        reason: 'ja「ログアウト」と同じ理由',
      },
    ],
  },

  // ─── UI 用語: /report の 4 章 ───
  {
    id: 'report-chapter-allocation',
    layer: 'ui',
    status: 'current',
    concept: 'Allocation (chapter 1)',
    ja: '配分',
    en: 'Allocation',
    usage: '1 章。時間そのものを分母（週 = 168h）に置いて、どこへ流れたかを見る',
    code: { identifiers: ['AllocationChapter'] },
  },
  {
    id: 'report-chapter-execution',
    layer: 'ui',
    status: 'current',
    concept: 'Execution (chapter 2)',
    ja: '執行',
    en: 'Execution',
    usage: '2 章。予定に対して記録がどう動いたか。全体遵守率のような合成値は作らない',
    code: { identifiers: ['ExecutionChapter'] },
  },
  {
    id: 'report-chapter-quality',
    layer: 'ui',
    status: 'current',
    concept: 'Quality (chapter 3)',
    ja: '質',
    en: 'Quality',
    usage: '3 章。投下時間と充実 / 消耗の関係を見る。中の散布図が「羅針盤」',
    code: { identifiers: ['QualityChapter'] },
  },
  {
    id: 'report-chapter-tidy',
    layer: 'ui',
    status: 'current',
    concept: 'Tidy (chapter 4)',
    ja: '整える',
    en: 'Tidy',
    usage: '4 章。未変換の外部カレンダー予定など、来週へ持ち越す前に片づけるもの',
    code: { identifiers: ['TidyChapter'] },
  },

  // ─── 設計語（UI 文言には出さない） ───
  {
    id: 'ink',
    layer: 'design',
    status: 'current',
    concept: 'Ink',
    ja: 'インク',
    en: 'Ink',
    usage: '記録として書かれた時間。決算バーの塗り',
    code: { identifiers: ['buildInkColumns'] },
  },
  {
    id: 'margin',
    layer: 'design',
    status: 'current',
    concept: 'Margin',
    ja: '余白',
    en: 'Margin',
    usage: '記録が書かれていない時間。分母には入るが塗らない。フィルタで動かない',
    code: { identifiers: ['marginMinutes'] },
    forbidden: [
      {
        term: '空白',
        locale: 'ja',
        enforcement: 'active',
        onlyNamespaces: ['report'],
        reason:
          'レポートでは「余白」。入力バリデーションの whitespace 義は別物なので report namespace だけを見る',
      },
      {
        term: '無駄',
        locale: 'ja',
        enforcement: 'active',
        reason: '余白に良し悪しの評価を持ち込まない',
      },
    ],
  },
  {
    id: 'ledger-bar',
    layer: 'design',
    status: 'current',
    concept: 'Ledger bar',
    ja: '決算バー',
    en: 'Ledger bar',
    usage: '1 章の横 1 本のバー。塗りがインク、塗り残しが余白。UI にラベルとしては出さない',
  },
  {
    id: 'mirror',
    layer: 'design',
    status: 'current',
    concept: 'Mirror',
    ja: '見積もりの鏡',
    en: 'Mirror',
    usage: '2 章の節。記録 / 過去予定の係数を癖の強い順に最大 3 件出す',
    code: { identifiers: ['buildMirrorRows'] },
  },
  {
    id: 'compass',
    layer: 'design',
    status: 'current',
    concept: 'Compass',
    ja: '羅針盤',
    en: 'Compass',
    usage: '3 章の散布図。横軸が投下時間、縦軸が充実と消耗の差。平均・回帰線・象限は作らない',
    code: { identifiers: ['CompassScatter', 'buildCompassPoints'] },
  },
  {
    id: 'two-lane',
    layer: 'design',
    status: 'current',
    concept: 'Two-lane view',
    ja: '2 レーン表示',
    en: 'Two-lane view',
    usage: '予定レーン（アウトライン・淡色）と記録レーン（塗り・主役）を横並びに出す',
    code: { identifiers: ['PlanLaneCard', 'RecordLaneCard'] },
  },
  {
    id: 'destination-rule',
    layer: 'design',
    status: 'current',
    concept: 'Destination rule',
    ja: '保存先ルール',
    en: 'Destination rule',
    usage:
      '新規作成は end_at だけで宛先が決まる（未来なら予定、過去なら記録）。種別選択の UI は置かない',
    code: { identifiers: ['resolveTimeblockDestination'] },
  },

  // ─── コード内部語 ───
  {
    id: 'timeblock-destination',
    layer: 'code',
    status: 'current',
    concept: 'Timeblock destination',
    usage:
      "予定 / 記録の判別子。canonical は 'plan' | 'record'。kind / lane / destination / sourceKind / resourceType が現状混在している",
    code: { identifiers: ['TimeblockDestination', 'kind', 'lane'] },
  },
  {
    id: 'timeblock-state',
    layer: 'code',
    status: 'current',
    concept: 'Timeblock state',
    usage: '時間位置から導く 3 値（upcoming / active / past）。実体は useCalendarData が持つ',
    code: { identifiers: ['TimeblockState'] },
  },
  {
    id: 'plan-source',
    layer: 'code',
    status: 'current',
    concept: 'Source',
    usage:
      '作成時に確定する不変の provenance。plans は manual / external_calendar / api、records はそれに from_plan / auto_migrated を加えた 5 値',
    code: { identifiers: ['PlanSource', 'RecordSource'] },
    db: ['plans.source', 'records.source'],
  },
  {
    id: 'ghost',
    layer: 'code',
    status: 'current',
    concept: 'Ghost',
    usage:
      'コード内で 3 つの無関係な意味に使われている: 外部カレンダーの未変換予定 / DnD 中の描画 / Button の variant',
    code: { identifiers: ['useConvertGhostEvent', 'GhostRenderer'] },
  },
  {
    id: 'restore',
    layer: 'code',
    status: 'current',
    concept: 'Restore',
    usage:
      '3 つの無関係な操作が同じ動詞を使っている: アーカイブ解除 / ゴミ箱からの復元 / バックアップ復元',
    code: { identifiers: ['restoreActivity', 'restorePlan'] },
  },
  {
    id: 'title-vs-name',
    layer: 'code',
    status: 'current',
    concept: 'title / name',
    usage:
      '時間を持つものは title（plans / records / plan_template_blocks / external_calendar_events）、分類は name（activities / categories / segments / plan_templates）',
  },
  {
    id: 'note-vs-description',
    layer: 'code',
    status: 'current',
    concept: 'note / description',
    usage:
      'Dayopt 自身のメモは note。description は外部カレンダー由来の本文と、MCP / メタタグの説明文にだけ使う',
    db: ['plans.note', 'records.note', 'external_calendar_events.description'],
  },
  {
    id: 'subscription-status',
    layer: 'code',
    status: 'current',
    concept: 'Subscription status',
    usage:
      'free / trialing / active / past_due / canceled。値の意味は docs/product/specs/billing.md',
    db: ['profiles.subscription_status'],
  },
  {
    id: 'timeblock-origin',
    layer: 'code',
    status: 'deprecated',
    concept: 'Timeblock origin',
    usage:
      "'planned' | 'unplanned'。生成元で意味が 2 つに割れており（予定そのものか / 予定に紐づく記録か）、主要な呼び出し側は既に kind から再計算して迂回している。撤去は別 issue",
    code: { identifiers: ['TimeblockOrigin'] },
    refs: ['#2637'],
  },

  // ─── 廃止予定 ───
  {
    id: 'skip',
    layer: 'ui',
    status: 'planned-removal',
    concept: 'Skip',
    ja: 'スキップ / やらなかった',
    en: 'Skip',
    usage: '概念ごと撤去する方針。新しい文言・docs でこの語彙を増やさない',
    code: { identifiers: ['skip', 'unskip'] },
    db: ['plans.skipped_at'],
    refs: ['decisions.md 2026-09-07', '#2636'],
  },
];

/**
 * i18n キー名に使わない token。
 *
 * 値が正しくてもキー名が旧語彙だと、AI が既存キーを手本にして旧語彙を再生産する
 * （`calendar.event.*` に 40 キーがぶら下がっている状態がそれ）。
 */
export const KEY_NAME_RULES: readonly KeyNameRule[] = [
  {
    token: 'task',
    preferred: 'timeblock / plan',
    enforcement: 'active',
    allowKeyPaths: ['^legal\\.'],
    reason: '旧語彙。Dayopt はタスクではなく時間を置く',
  },
  {
    token: 'tasks',
    preferred: 'timeblock / plan',
    enforcement: 'active',
    allowKeyPaths: ['^legal\\.'],
    reason: '同上（複数形）',
  },
  {
    token: 'entry',
    preferred: 'timeblock / plan / record',
    enforcement: 'active',
    allowKeyPaths: ['manualEntry$'],
    reason: 'ADR-025 で廃止した Entry モデルの名残。MFA コードの manual entry は別義',
  },
  {
    token: 'entries',
    preferred: 'timeblock / plan / record',
    enforcement: 'active',
    allowKeyPaths: [
      '^oauth\\.consent\\.scope\\.',
      '^settings\\.integrations\\.mcpConnections\\.scopes\\.',
    ],
    reason: '同上。OAuth scope 名 read:entries は外部契約なのでキー名ごと据え置き',
  },
  {
    token: 'tag',
    preferred: 'activity / category / segment',
    enforcement: 'active',
    reason: '#2162 で廃止した Tag 機能の名残',
  },
  {
    token: 'tags',
    preferred: 'activity / category / segment',
    enforcement: 'active',
    reason: '同上（複数形）',
  },
  {
    token: 'event',
    preferred: 'timeblock / plan',
    enforcement: 'active',
    allowKeyPaths: ['^calendar\\.external\\.', 'externalEvents', 'ghost'],
    reason: 'event は外部カレンダー由来の予定にだけ使う',
  },
  {
    token: 'events',
    preferred: 'timeblock / plan',
    enforcement: 'active',
    allowKeyPaths: ['^calendar\\.external\\.', 'externalEvents', 'ghost'],
    reason: '同上（複数形）',
  },
];
