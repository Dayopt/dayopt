'use client';

import { ActivityFieldRow } from '../inspector/fields';

interface TimeblockActivityCardProps {
  activityId: string | null;
  activityName: string;
  categoryName?: string | null | undefined;
  activityIcon?: string | null | undefined;
  activityColor?: string | null | undefined;
  uncategorized?: boolean | undefined;
  onActivityChange: (activityId: string | null) => void;
  onCreateAndSelect: (
    name: string,
    color?: string | null,
    icon?: string | null,
    categoryId?: string | null,
  ) => void;
  disabled?: boolean | undefined;
  durationByActivityId?: ReadonlyMap<string, number> | undefined;
}

/** アクティビティ選択を独立したカードとして表示する。 */
export function TimeblockActivityCard({
  activityId,
  activityName,
  categoryName,
  activityIcon,
  activityColor,
  uncategorized,
  onActivityChange,
  onCreateAndSelect,
  disabled,
  durationByActivityId,
}: TimeblockActivityCardProps) {
  return (
    <div className="mx-4 mb-3">
      <ActivityFieldRow
        variant="card"
        activityId={activityId}
        activityName={activityName}
        categoryName={categoryName}
        activityIcon={activityIcon}
        activityColor={activityColor}
        uncategorized={uncategorized}
        onActivityChange={onActivityChange}
        onCreateAndSelect={onCreateAndSelect}
        disabled={disabled}
        durationByActivityId={durationByActivityId}
      />
    </div>
  );
}
