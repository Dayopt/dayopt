export const TIMEBLOCK_CSV_COLUMNS = [
  'kind',
  'id',
  'title',
  'note',
  'activity_id',
  'start_at',
  'end_at',
  'source',
  'fulfillment',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const CSV_QUOTING_CHARACTER = /[,"\n\r]/;

/**
 * Spreadsheet が数式として解釈する先頭文字を、明示的な文字列へ変換する。
 * CSV を Excel / Google Sheets で開いた時に title / note 等が実行可能な式にならないための境界。
 */
export function escapeTimeblockCsvField(value: unknown): string {
  if (value == null) return '';

  const text = String(value);
  const neutralized = SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;
  if (CSV_QUOTING_CHARACTER.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/** plans / records を、固定列順と LF 区切りの CSV 文字列へ変換する。 */
export function timeblockRowsToCsv(rows: Record<string, unknown>[]): string {
  const header = TIMEBLOCK_CSV_COLUMNS.join(',');
  const csvRows = rows.map((row) =>
    TIMEBLOCK_CSV_COLUMNS.map((column) => escapeTimeblockCsvField(row[column])).join(','),
  );
  return [header, ...csvRows].join('\n');
}
