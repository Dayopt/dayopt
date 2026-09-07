import { describe, expect, it } from 'vitest';

import {
  escapeTimeblockCsvField,
  TIMEBLOCK_CSV_COLUMNS,
  timeblockRowsToCsv,
} from './timeblock-csv-export';

describe('escapeTimeblockCsvField', () => {
  it.each([
    ['=', '=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+', '+1+1', "'+1+1"],
    ['-', '-2+3', "'-2+3"],
    ['@', '@SUM(A1)', "'@SUM(A1)"],
    ['tab', '\t=1+1', "'\t=1+1"],
    ['carriage return', '\r=1+1', '"\'\r=1+1"'],
  ])('%s で始まる値を文字列として扱う', (_label, input, expected) => {
    expect(escapeTimeblockCsvField(input)).toBe(expected);
  });

  it.each([
    ['ordinary', 'Plan', 'Plan'],
    ['comma', 'Plan, record', '"Plan, record"'],
    ['quote', 'Say "hello"', '"Say ""hello"""'],
    ['line feed', 'first\nsecond', '"first\nsecond"'],
    ['carriage return', 'first\rsecond', '"first\rsecond"'],
    ['null', null, ''],
  ])('%s の CSV field escaping を保つ', (_label, input, expected) => {
    expect(escapeTimeblockCsvField(input)).toBe(expected);
  });
});

describe('timeblockRowsToCsv', () => {
  it('defined columns以外の内部値はexportしない', () => {
    const csv = timeblockRowsToCsv([
      {
        kind: 'record',
        id: 'rec',
        internal_value: 'not-exported',
        source: 'from_plan',
      },
    ]);
    expect(csv).not.toContain('internal_value');
    expect(csv).not.toContain('not-exported');
    expect(csv).toContain('from_plan');
  });
  it('header・列順・LF record separator を固定する', () => {
    const csv = timeblockRowsToCsv([
      { kind: 'plan', id: 'plan-1', title: '=2+2', note: null },
      { kind: 'record', id: 'record-1', title: 'Done', note: 'line 1\rline 2' },
    ]);

    const lines = csv.split('\n');
    expect(lines[0]).toBe(TIMEBLOCK_CSV_COLUMNS.join(','));
    expect(lines[1]?.startsWith("plan,plan-1,'=2+2,,")).toBe(true);
    expect(csv).toContain('record,record-1,Done,"line 1\rline 2",');
    expect(csv).not.toContain('\r\n');
  });

  it('fulfillment を設定した Record は CSV へ復元可能な形で含める', () => {
    const csv = timeblockRowsToCsv([
      { kind: 'record', id: 'record-1', title: 'Deep work', fulfillment: 'high' },
    ]);

    expect(TIMEBLOCK_CSV_COLUMNS).toContain('fulfillment');
    const fulfillmentIndex = TIMEBLOCK_CSV_COLUMNS.indexOf('fulfillment');
    const row = csv.split('\n')[1]?.split(',');
    expect(row?.[fulfillmentIndex]).toBe('high');
  });
});
