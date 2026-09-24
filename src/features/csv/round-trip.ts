import { CsvDataError, parseCsv, writeCsv } from './csv';

export type CsvValueType =
  | { kind: 'text'; maxLength?: number }
  | { kind: 'integer'; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: 'decimal'; precision: number; scale: number }
  | { kind: 'boolean' | 'date' }
  | { kind: 'datetime' | 'datetimeOffset'; fractionalDigits: number }
  | { kind: 'binary'; maxBytes?: number };
export interface CsvColumn {
  name: string;
  nullable: boolean;
  type: CsvValueType;
}
export interface CsvMetadata {
  format: 'relagrid-csv';
  version: 1;
  encoding: 'utf-8';
  bom: true;
  delimiter: ',';
  header: true;
  newline: 'CRLF';
  nullEncoding: 'backslash-v1';
  rowCount: number;
  columns: CsvColumn[];
}
const dialect = {
  format: 'relagrid-csv',
  version: 1,
  encoding: 'utf-8',
  bom: true,
  delimiter: ',',
  header: true,
  newline: 'CRLF',
  nullEncoding: 'backslash-v1',
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('メタデータのオブジェクトが不正です');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

// Treat loaded metadata as untrusted: never cast an unknown type into a supported type.
export function readMetadata(value: unknown): CsvMetadata {
  const meta = object(value);
  for (const [key, expected] of Object.entries(dialect)) {
    if (meta[key] !== expected) throw new Error(`未対応のCSVメタデータ: ${key}`);
  }
  if (
    !integer(meta.rowCount, 0, 10000) ||
    !Array.isArray(meta.columns) ||
    !meta.columns.length ||
    meta.columns.length > 4096
  )
    throw new Error('メタデータの行数・列数が範囲外です');
  const columns = meta.columns.map((item, index): CsvColumn => {
    try {
      const column = object(item),
        type = object(column.type);
      if (typeof column.name !== 'string' || typeof column.nullable !== 'boolean')
        throw new Error('列定義が不正です');
      let validated: CsvValueType;
      switch (type.kind) {
        case 'text':
          if (type.maxLength !== undefined && !integer(type.maxLength, 0, 32 * 1024 * 1024))
            throw new Error('文字数上限が不正です');
          validated = { kind: 'text', maxLength: type.maxLength as number | undefined };
          break;
        case 'binary':
          if (type.maxBytes !== undefined && !integer(type.maxBytes, 0, 16 * 1024 * 1024))
            throw new Error('バイナリ上限が不正です');
          validated = { kind: 'binary', maxBytes: type.maxBytes as number | undefined };
          break;
        case 'integer':
          if (![8, 16, 32, 64].includes(type.bits as number) || typeof type.signed !== 'boolean')
            throw new Error('整数型が不正です');
          validated = { kind: 'integer', bits: type.bits as 8 | 16 | 32 | 64, signed: type.signed };
          break;
        case 'decimal':
          if (!integer(type.precision, 1, 65) || !integer(type.scale, 0, type.precision))
            throw new Error('精度・スケールが不正です');
          validated = { kind: 'decimal', precision: type.precision, scale: type.scale };
          break;
        case 'datetime':
        case 'datetimeOffset':
          if (!integer(type.fractionalDigits, 0, 7)) throw new Error('小数秒精度が不正です');
          validated = { kind: type.kind, fractionalDigits: type.fractionalDigits };
          break;
        case 'date':
        case 'boolean':
          validated = { kind: type.kind };
          break;
        default:
          throw new Error('未対応の型です');
      }
      return { name: column.name, nullable: column.nullable, type: validated };
    } catch (error) {
      throw new CsvDataError((error as Error).message, 1, index + 1);
    }
  });
  return { ...dialect, rowCount: meta.rowCount, columns };
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match,
    year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}
function validTime(
  value: string,
  type: Extract<CsvValueType, { fractionalDigits: number }>,
): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return false;
  const [, date, h, m, s, fraction = '', offset] = match;
  if (
    !validDate(date) ||
    Number(h) > 23 ||
    Number(m) > 59 ||
    Number(s) > 59 ||
    fraction.length > type.fractionalDigits
  )
    return false;
  if (type.kind === 'datetime') return offset === undefined;
  if (!offset) return false;
  if (offset === 'Z') return true;
  const hours = Number(offset.slice(1, 3)),
    minutes = Number(offset.slice(4));
  return hours <= 14 && minutes <= 59 && (hours !== 14 || minutes === 0);
}

function validateValue(value: string | null, column: CsvColumn, record: number, position: number) {
  const fail = (code: string): never => {
    throw new CsvDataError(code, record, position);
  };
  if (value === null) {
    if (!column.nullable) fail('NULLを許可しない列です');
    return;
  }
  if (typeof value !== 'string') fail('値は文字列またはNULLで指定してください');
  const type = column.type;
  let valid = false;
  switch (type.kind) {
    case 'text': {
      let length = 0;
      if (type.maxLength !== undefined) {
        for (const _character of value) {
          if (++length > type.maxLength) break;
        }
      }
      valid = type.maxLength === undefined || length <= type.maxLength;
      break;
    }
    case 'integer': {
      if (!/^-?(0|[1-9]\d*)$/.test(value) || value.length > 21) break;
      const bits = BigInt(type.bits),
        number = BigInt(value);
      valid = type.signed
        ? number >= -(1n << (bits - 1n)) && number < 1n << (bits - 1n)
        : number >= 0n && number < 1n << bits;
      break;
    }
    case 'decimal': {
      const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
      valid =
        !!match &&
        (match[1] === '0' ? 0 : match[1].length) <= type.precision - type.scale &&
        (match[2]?.length ?? 0) <= type.scale;
      break;
    }
    case 'boolean':
      valid = value === 'true' || value === 'false';
      break;
    case 'date':
      valid = validDate(value);
      break;
    case 'datetime':
    case 'datetimeOffset':
      valid = validTime(value, type);
      break;
    case 'binary':
      valid =
        /^(?:[0-9a-fA-F]{2})*$/.test(value) &&
        (type.maxBytes === undefined || value.length / 2 <= type.maxBytes);
      break;
  }
  if (!valid) fail(`${type.kind}の形式・範囲・精度に適合しません`);
}

export function encodeRoundTrip(
  columns: CsvColumn[],
  rows: (string | null)[][],
): { csv: string; metadata: CsvMetadata } {
  const metadata = readMetadata({ ...dialect, rowCount: rows.length, columns });
  const records = rows.map((row, index) => {
    if (row.length !== columns.length) throw new CsvDataError('列数が一致しません', index + 2, 1);
    return row.map((value, col) => {
      validateValue(value, metadata.columns[col], index + 2, col + 1);
      return value === null ? '\\N' : value.startsWith('\\') ? `\\${value}` : value;
    });
  });
  const csv = writeCsv([metadata.columns.map((column) => column.name), ...records]);
  // This first API handles bounded files; streaming file I/O is RG-05/06.
  parseCsv(csv);
  return { csv, metadata };
}

export function decodeRoundTrip(
  csv: string,
  rawMetadata: unknown,
): { columns: CsvColumn[]; rows: (string | null)[][] } {
  const metadata = readMetadata(rawMetadata),
    records = parseCsv(csv);
  const header = records[0];
  if (!header || header.length !== metadata.columns.length)
    throw new CsvDataError('ヘッダー列数が一致しません', 1, 1);
  metadata.columns.forEach((column, index) => {
    if (header[index] !== column.name)
      throw new CsvDataError('ヘッダー名・列順が一致しません', 1, index + 1);
  });
  if (records.length - 1 !== metadata.rowCount)
    throw new CsvDataError('メタデータの行数が一致しません', records.length + 1, 1);
  const rows = records.slice(1).map((row, index) =>
    row.map((cell, col) => {
      if (cell.startsWith('\\') && cell !== '\\N' && !cell.startsWith('\\\\'))
        throw new CsvDataError('不正なNULLエスケープです', index + 2, col + 1);
      const value = cell === '\\N' ? null : cell.startsWith('\\\\') ? cell.slice(1) : cell;
      validateValue(value, metadata.columns[col], index + 2, col + 1);
      return value;
    }),
  );
  return { columns: metadata.columns, rows };
}
