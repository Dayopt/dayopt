import { useState } from 'react';

import {
  Button,
  Drawer,
  DrawerContent,
  DrawerTitle,
  FloatingActionBarItem,
} from '@dayopt/components';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Check, Clock3, Ellipsis } from 'lucide-react';

import type { PublicPlanRow, PublicRecordRow } from '@/lib/database';

import { PRESET_USER_SETTINGS } from '../../../../../../storybook/.storybook/mocks/presets';
import { TimeblockInspectorForm } from './TimeblockInspectorForm';

const plan = {
  id: '00000000-0000-4000-8000-000000000001',
  user_id: 'storybook-user',
  activity_id: null,
  external_calendar_event_id: null,
  title: '',
  note: null,
  start_at: '2020-07-14T00:00:00.000Z',
  end_at: '2020-07-14T01:00:00.000Z',
  source: 'manual',
  deleted_at: null,
  created_at: '2020-07-14T00:00:00.000Z',
  updated_at: '2020-07-14T00:00:00.000Z',
} satisfies PublicPlanRow;

const record = {
  ...plan,
  id: '00000000-0000-4000-8000-000000000002',
  source: 'manual',
  fulfillment: 'high',
} satisfies PublicRecordRow;

function DraftActions() {
  return (
    <>
      {[Check, Clock3, Ellipsis].map((Icon, index) => (
        <FloatingActionBarItem key={index}>
          <Icon aria-hidden="true" />
          {`ボタン${index + 1}`}
        </FloatingActionBarItem>
      ))}
    </>
  );
}

function MobilePreview({ kind }: { kind: 'plan' | 'record' }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>シートを開く</Button>
      <Drawer open={open} onOpenChange={setOpen} handleOnly repositionInputs={false}>
        <DrawerContent className="flex flex-col gap-0 overflow-hidden p-0">
          <DrawerTitle className="sr-only">{kind === 'plan' ? '予定' : '記録'}</DrawerTitle>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="mx-auto w-full max-w-lg">
              <TimeblockInspectorForm
                kind={kind}
                plan={kind === 'plan' ? plan : undefined}
                record={kind === 'record' ? record : undefined}
                actionsSlot={<DraftActions />}
                onDeleted={() => setOpen(false)}
                onCloseInspector={() => setOpen(false)}
              />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

const meta = {
  title: 'Product/Features/Timeblock/Inspector/Form',
  component: TimeblockInspectorForm,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    trpcMocks: {
      'activities.listActivities': [],
      'activities.listCategories': [],
      'activities.listTree': { categories: [], uncategorized: [] },
      'statistics.getActivityStats': { medianMinutes: {} },
      'statistics.getActivityEstimationFactors': [],
      'userSettings.get': PRESET_USER_SETTINGS.default,
    },
  },
  args: { kind: 'plan', plan, onDeleted: () => undefined, actionsSlot: <DraftActions /> },
  argTypes: { actionsSlot: { control: false } },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeblockInspectorForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 予定の内容末尾に操作バーを表示する。 */
export const Plan: Story = {};

/** 記録の内容末尾に操作バーを表示する。 */
export const Record: Story = { args: { kind: 'record', plan: undefined, record } };

/** モバイルの予定シート。内容と操作バーが一緒にスクロールする。 */
export const MobilePlan: Story = { render: () => <MobilePreview kind="plan" /> };

/** モバイルの記録シート。内容と操作バーが一緒にスクロールする。 */
export const MobileRecord: Story = { render: () => <MobilePreview kind="record" /> };

/** 全パターン一覧。モバイルのシートは個別Storyで表示する。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="space-y-6">
      <TimeblockInspectorForm {...meta.args} />
      <TimeblockInspectorForm {...meta.args} kind="record" plan={undefined} record={record} />
    </div>
  ),
};
