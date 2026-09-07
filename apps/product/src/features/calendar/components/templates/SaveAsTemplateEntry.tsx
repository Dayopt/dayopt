'use client';

import { useState } from 'react';

import { LayoutTemplate } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AppHeader } from '@/components/shell/AppHeader';
import { Button } from '@dayopt/components';

import { MiniDayPreview } from './MiniDayPreview';
import { SaveAsTemplateHeader } from './SaveAsTemplateHeader';
import type { TemplateBlockView } from './types';

interface SaveAsTemplateEntryProps {
  /** 保存対象となる「生きた日」の組成（このコンポーネント自身は日を編集しない） */
  dayBlocks: ReadonlyArray<TemplateBlockView>;
  onSave?: ((name: string) => void) | undefined;
  onCancel?: (() => void) | undefined;
}

/**
 * 「この並びを型として保存」の入口と、そこから入れ替わるヘッダーの**組み合わせ見本**。
 *
 * 作成は常に生きた日からのみ行う。白紙から型を設計させる導線は持たない
 * （空フォルダ病の予防）。トリガーを押すとポップアップは開かず、ヘッダー表示が
 * 名前入力（左）＋保存 / キャンセル（右）へ入れ替わり、メインはそのまま
 * 「保存対象の日の盤面」を表示し続ける。
 *
 * **製品の実配線はこの component を通らない**（#2567）。実際のトリガーは
 * `ViewSwitcher` のメニュー項目で、入れ替わるヘッダーは `CalendarLayout` が描く
 * ただ 1 つの `AppHeader` の中身を `SaveAsTemplateHeader` へ差し替える形で実現する
 * （1 画面 1 header を守り、盤面を潰さないため）。ここは Storybook でその組み合わせを
 * 1 画面として確認するための composition で、メイン領域は実際の日ビューの代わりに
 * `MiniDayPreview` を置いている。
 */
export function SaveAsTemplateEntry({ dayBlocks, onSave, onCancel }: SaveAsTemplateEntryProps) {
  const t = useTranslations();
  const [isEditing, setIsEditing] = useState(false);

  if (!isEditing) {
    return (
      <Button variant="ghost" className="justify-start gap-2" onClick={() => setIsEditing(true)}>
        <LayoutTemplate className="size-4" />
        {t('calendar.templates.saveLabel')}
      </Button>
    );
  }

  return (
    <div className="bg-background flex h-full w-full flex-col">
      <AppHeader>
        <SaveAsTemplateHeader
          onSave={(name) => {
            onSave?.(name);
            setIsEditing(false);
          }}
          onCancel={() => {
            setIsEditing(false);
            onCancel?.();
          }}
        />
      </AppHeader>

      <div className="min-h-0 flex-1 p-4">
        <MiniDayPreview blocks={dayBlocks} />
      </div>
    </div>
  );
}
