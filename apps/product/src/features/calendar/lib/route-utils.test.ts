import { describe, expect, it } from 'vitest';

import { isCalendarViewPath } from './route-utils';

describe('isCalendarViewPath', () => {
  describe('正常系', () => {
    it('/（ホーム）→ true', () => {
      expect(isCalendarViewPath('/')).toBe(true);
    });

    it('/?view=week のようにクエリが付いていても true', () => {
      expect(isCalendarViewPath('/?view=week')).toBe(true);
    });
  });

  describe('false 判定', () => {
    it('空の pathname もホームとして扱う', () => {
      expect(isCalendarViewPath('')).toBe(true);
      expect(isCalendarViewPath('/calendar')).toBe(false);
    });

    it('未対応セグメントは false', () => {
      expect(isCalendarViewPath('/month')).toBe(false);
      expect(isCalendarViewPath('/year')).toBe(false);
    });

    it('workspace ビュー以外のパスは false', () => {
      expect(isCalendarViewPath('/report')).toBe(false);
      expect(isCalendarViewPath('/review')).toBe(false);
      expect(isCalendarViewPath('/settings')).toBe(false);
      expect(isCalendarViewPath('/tags')).toBe(false);
    });

    it('旧 calendar namespace のサブパスは false（先頭セグメントが calendar でも完全一致でなければ false）', () => {
      expect(isCalendarViewPath('/calendar/day')).toBe(false);
      expect(isCalendarViewPath('/api/calendar/day')).toBe(false);
    });

    // 旧 /day /week /Nday は proxy.ts の redirect で /calendar へ集約済み
    // （epic #2181 Step 6、#2195）。この関数はアプリ内部の pathname のみを見るため
    // redirect 前提の旧パスは false になる（redirect の契約自体は proxy.test.ts が担保する）。
    it('旧 day/week/Nday パスは false（proxy の redirect が担保する。この関数の対象外）', () => {
      expect(isCalendarViewPath('/day')).toBe(false);
      expect(isCalendarViewPath('/week')).toBe(false);
      expect(isCalendarViewPath('/3day')).toBe(false);
    });
  });
});
