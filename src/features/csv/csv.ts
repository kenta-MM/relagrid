import { parse } from 'csv-parse/browser/esm/sync';
import { stringify } from 'csv-stringify/browser/esm/sync';
import type { Preview } from '@/domain/database';

export const MAX_CSV_BYTES = 32 * 1024 * 1024;
export class CsvDataError extends Error {
  constructor(
    public readonly code: string,
    public readonly record: number,
    public readonly column: number,
  ) {
    super(`CSV レコード${record}・列${column}: ${code}`);
    this.name = 'CsvDataError';
  }
}

export function decodeCsvUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CSV_BYTES)
    throw new CsvDataError('ファイル上限32MiBを超えています', 1, 1);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvDataError('不正なUTF-8です', 1, 1);
  }
}

export function parseCsv(text: string): string[][] {
  assertUnicode(text, 1, 1);
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES)
    throw new CsvDataError('ファイル上限32MiBを超えています', 1, 1);
  try {
    return parse(text, {
      bom: true,
      delimiter: ',',
      record_delimiter: ['\r\n', '\n'],
      skip_empty_lines: false,
      max_record_size: 8 * 1024 * 1024,
      cast(value, context) {
        if (context.index >= 4096)
          throw new CsvDataError(
            '列数上限4096を超えています',
            context.records + 1,
            context.index + 1,
          );
        if (context.records >= 10001)
          throw new CsvDataError('データ行数上限10000を超えています', context.records + 1, 1);
        return value;
      },
    });
  } catch (error) {
    if (error instanceof CsvDataError) throw error;
    const details = error as { code?: string; records?: number; column?: number };
    // Parser messages can contain cell values; expose only its code and position.
    throw new CsvDataError(
      details.code ?? 'CSV構文エラー',
      (details.records ?? 0) + 1,
      typeof details.column === 'number' ? details.column + 1 : 1,
    );
  }
}

export function assertUnicode(value: string, record: number, column: number): void {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new CsvDataError('不正なUnicode文字です', record, column);
  }
}

export function writeCsv(records: string[][]): string {
  records.forEach((row, record) =>
    row.forEach((value, column) => assertUnicode(value, record + 1, column + 1)),
  );
  return stringify(records, {
    bom: true,
    delimiter: ',',
    record_delimiter: '\r\n',
    quoted: true,
    quoted_empty: true,
    eof: false,
  });
}

// Spreadsheet-friendly export intentionally does not preserve NULL or formula-like text.
export function exportGenericCsv(preview: Preview): string {
  return writeCsv(
    [preview.columns, ...preview.rows].map((row) =>
      row.map((value) => {
        const text = value ?? '';
        return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      }),
    ),
  );
}
