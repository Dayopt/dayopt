import { describe, expect, it } from 'vitest';

import { dayoptDomains } from '@dayopt/config';

import { plansToICal } from './plan-to-ical';

interface ICalPlanInput {
  id: string;
  title: string;
  note: string | null;
  start_at: string | null;
  end_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function makePlan(overrides: Partial<ICalPlanInput> & { id: string }): ICalPlanInput {
  return {
    title: 'Sample',
    note: null,
    start_at: '2026-04-27T01:00:00.000Z',
    end_at: '2026-04-27T02:00:00.000Z',
    created_at: '2026-04-26T00:00:00.000Z',
    updated_at: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

const calendarUid = (timeblockId: string) => `UID:${timeblockId}@${dayoptDomains.marketing}`;

describe('plansToICal', () => {
  describe('VCALENDAR エンベロープ', () => {
    it('BEGIN:VCALENDAR / END:VCALENDAR で囲まれる', () => {
      const ical = plansToICal([]);
      expect(ical).toMatch(/^BEGIN:VCALENDAR\r\n/);
      expect(ical).toMatch(/END:VCALENDAR\r\n$/);
    });

    it('必須ヘッダ（VERSION / PRODID / CALSCALE / METHOD / X-WR-CALNAME）を含む', () => {
      const ical = plansToICal([]);
      expect(ical).toContain('VERSION:2.0');
      expect(ical).toContain('PRODID:-//Dayopt//Calendar Feed//EN');
      expect(ical).toContain('CALSCALE:GREGORIAN');
      expect(ical).toContain('METHOD:PUBLISH');
      expect(ical).toContain('X-WR-CALNAME:Dayopt');
    });

    it('行末は CRLF で区切られる（RFC 5545 Section 3.1）', () => {
      const ical = plansToICal([]);
      expect(ical.split('\r\n').length).toBeGreaterThan(1);
      // CR を含まない LF のみは存在しない
      expect(ical).not.toMatch(/[^\r]\n/);
    });
  });

  describe('VEVENT 生成', () => {
    it('start_at / end_at が揃った Plan は VEVENT に含まれる', () => {
      const ical = plansToICal([makePlan({ id: 'e1', title: 'Meeting' })]);
      expect(ical).toContain('BEGIN:VEVENT');
      expect(ical).toContain('END:VEVENT');
      expect(ical).toContain(calendarUid('e1'));
      expect(ical).toContain('SUMMARY:Meeting');
    });

    it('start_at / end_at のいずれかが null なら VEVENT を生成しない', () => {
      const ical = plansToICal([
        makePlan({ id: 'no-start', start_at: null }),
        makePlan({ id: 'no-end', end_at: null }),
      ]);
      expect(ical).not.toContain('BEGIN:VEVENT');
    });

    it('複数の Plan は順序通りに VEVENT として並ぶ', () => {
      const ical = plansToICal([
        makePlan({ id: 'a', title: 'A' }),
        makePlan({ id: 'b', title: 'B' }),
      ]);
      const aIndex = ical.indexOf(calendarUid('a'));
      const bIndex = ical.indexOf(calendarUid('b'));
      expect(aIndex).toBeGreaterThan(0);
      expect(bIndex).toBeGreaterThan(aIndex);
    });
  });

  describe('日時変換（toICalDateTime）', () => {
    it('ISO 文字列を YYYYMMDDTHHMMSSZ 形式に変換する', () => {
      const ical = plansToICal([
        makePlan({
          id: 'e1',
          start_at: '2026-03-17T09:00:00+09:00',
          end_at: '2026-03-17T10:00:00+09:00',
        }),
      ]);
      // JST 09:00 = UTC 00:00
      expect(ical).toContain('DTSTART:20260317T000000Z');
      expect(ical).toContain('DTEND:20260317T010000Z');
    });

    it('UTC 入力もそのまま UTC として出力される', () => {
      const ical = plansToICal([
        makePlan({
          id: 'e1',
          start_at: '2026-04-27T01:00:00.000Z',
          end_at: '2026-04-27T02:00:00.000Z',
        }),
      ]);
      expect(ical).toContain('DTSTART:20260427T010000Z');
      expect(ical).toContain('DTEND:20260427T020000Z');
    });
  });

  describe('SUMMARY', () => {
    // #2175: 旧実装は旧タグ名を優先し title へ fallback していた。tags 撤去で
    // SUMMARY は常に Plan のタイトルになる。
    it('SUMMARY は Plan のタイトルを使う', () => {
      const ical = plansToICal([makePlan({ id: 'e1', title: 'Meeting' })]);
      expect(ical).toContain('SUMMARY:Meeting');
    });
  });

  describe('escapeICalText（RFC 5545 Section 3.3.11）', () => {
    it('セミコロン / カンマ / 改行 / バックスラッシュをエスケープする', () => {
      const ical = plansToICal([
        makePlan({
          id: 'e1',
          title: 'a;b,c\nd\\e',
        }),
      ]);
      expect(ical).toContain('SUMMARY:a\\;b\\,c\\nd\\\\e');
    });

    it('note（DESCRIPTION）にも同じエスケープを適用する', () => {
      const ical = plansToICal([
        makePlan({
          id: 'e1',
          note: 'line1\nline2; with comma,',
        }),
      ]);
      expect(ical).toContain('DESCRIPTION:line1\\nline2\\; with comma\\,');
    });

    it('バックスラッシュは他の文字より先にエスケープされる（二重エスケープ防止）', () => {
      // \ → \\ は最初に処理される必要がある
      // もし , を先に処理すると \, が \\\, になってしまう
      const ical = plansToICal([makePlan({ id: 'e1', title: '\\' })]);
      expect(ical).toContain('SUMMARY:\\\\');
      // \\\\ は出現するが \\\\\\ は出現しない（過剰エスケープを防ぐ）
      expect(ical).not.toMatch(/SUMMARY:\\\\\\\\/);
    });

    it('note が null の場合は DESCRIPTION 行を出さない', () => {
      const ical = plansToICal([makePlan({ id: 'e1', note: null })]);
      expect(ical).not.toContain('DESCRIPTION:');
    });

    it('裸の CR を含む title は \\n として正規化される（生の \\r は出力に残らない）', () => {
      const ical = plansToICal([makePlan({ id: 'e1', title: 'line1\rline2' })]);
      const summaryStart = ical.indexOf('SUMMARY:');
      const summaryLine = ical.slice(summaryStart, ical.indexOf('\r\n', summaryStart));
      expect(summaryLine).toBe('SUMMARY:line1\\nline2');
      expect(summaryLine).not.toMatch(/\r/);
    });

    it('CRLF ペアを含む title も二重エスケープなしで \\n 1 個に正規化される', () => {
      const ical = plansToICal([makePlan({ id: 'e1', title: 'line1\r\nline2' })]);
      const summaryStart = ical.indexOf('SUMMARY:');
      const summaryLine = ical.slice(summaryStart, ical.indexOf('\r\n', summaryStart));
      expect(summaryLine).toBe('SUMMARY:line1\\nline2');
      expect(summaryLine).not.toMatch(/\r/);
    });
  });

  describe('foldLine（75 オクテット折返）', () => {
    it('75 文字以下の行は折り返さない', () => {
      const ical = plansToICal([makePlan({ id: 'short', title: 'A' })]);
      // SUMMARY:A は 9 文字 → 折返なし
      expect(ical).toContain('SUMMARY:A\r\n');
    });

    it('長い title は折り返される（次行は半角スペースで始まる）', () => {
      const longTitle = 'a'.repeat(200);
      const ical = plansToICal([makePlan({ id: 'long', title: longTitle })]);

      const summaryStart = ical.indexOf('SUMMARY:');
      const summarySection = ical.slice(summaryStart);
      // 折返後の続行は CRLF + space で始まる
      expect(summarySection).toMatch(/\r\n /);
    });

    it('UID が長い場合（理論上は短いが）も折返処理が適用される', () => {
      const longId = 'x'.repeat(200);
      const ical = plansToICal([makePlan({ id: longId })]);
      const uidStart = ical.indexOf('UID:');
      const uidSection = ical.slice(uidStart);
      expect(uidSection).toMatch(/\r\n /);
    });
  });

  describe('DTSTAMP / LAST-MODIFIED は値があるときだけ出力', () => {
    it('created_at が null なら DTSTAMP を出さない', () => {
      const ical = plansToICal([makePlan({ id: 'e1', created_at: null })]);
      expect(ical).not.toContain('DTSTAMP:');
    });

    it('updated_at が null なら LAST-MODIFIED を出さない', () => {
      const ical = plansToICal([makePlan({ id: 'e1', updated_at: null })]);
      expect(ical).not.toContain('LAST-MODIFIED:');
    });

    it('両方あれば両方出力する', () => {
      const ical = plansToICal([
        makePlan({
          id: 'e1',
          created_at: '2026-04-26T00:00:00.000Z',
          updated_at: '2026-04-26T05:00:00.000Z',
        }),
      ]);
      expect(ical).toContain('DTSTAMP:20260426T000000Z');
      expect(ical).toContain('LAST-MODIFIED:20260426T050000Z');
    });
  });

  it('空配列はカレンダーエンベロープのみ返す', () => {
    const ical = plansToICal([]);
    expect(ical).not.toContain('BEGIN:VEVENT');
    expect(ical).toContain('BEGIN:VCALENDAR');
    expect(ical).toContain('END:VCALENDAR');
  });
});
