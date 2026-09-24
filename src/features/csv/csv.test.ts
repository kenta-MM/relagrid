import { describe, expect, it } from 'vitest';
import { CsvDataError, decodeCsvUtf8, exportGenericCsv, parseCsv, writeCsv } from './csv';
import {
  decodeRoundTrip,
  encodeRoundTrip,
  readMetadata,
  type CsvColumn,
  type CsvValueType,
} from './round-trip';

const textColumn: CsvColumn = { name: 'text', nullable: true, type: { kind: 'text' } };
function roundTrip(value: string | null, type: CsvValueType = { kind: 'text' }) {
  const file = encodeRoundTrip([{ ...textColumn, type }], [[value]]);
  return decodeRoundTrip(file.csv, JSON.parse(JSON.stringify(file.metadata))).rows[0][0];
}

describe('CSV syntax and generic export', () => {
  it('round trips commas, quotes, line breaks, whitespace and Unicode without trimming', () => {
    const records = [
      ['a', 'b'],
      ['comma,here', '"quote"'],
      ["O'Brien", '日本語😀'],
      ['CR\r\nLF\n', '  '],
      ['', '=1+1'],
    ];
    const csv = writeCsv(records);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('""quote""');
    expect(parseCsv(csv)).toEqual(records);
    expect(parseCsv('a,b\n"first\nsecond",  \n')).toEqual([
      ['a', 'b'],
      ['first\nsecond', '  '],
    ]);
  });
  it('reports record and column without disclosing the invalid input', () => {
    for (const csv of ['a,b\r\n1,"secret', 'a,b\n1,"secret"x', 'a,b\n1']) {
      try {
        parseCsv(csv);
        throw new Error('expected parser error');
      } catch (error) {
        expect(error).toBeInstanceOf(CsvDataError);
        expect((error as CsvDataError).record).toBe(2);
        expect((error as CsvDataError).column).toBeGreaterThanOrEqual(1);
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
  it('keeps the existing generic export null and spreadsheet protection behavior', () => {
    const csv = exportGenericCsv({
      columns: ['v'],
      rows: [[null], [''], ['=1'], ['-1'], ["O'Brien"], ['\\N']],
    });
    expect(parseCsv(csv)).toEqual([['v'], [''], [''], ["'=1"], ["'-1"], ["O'Brien"], ['\\N']]);
  });
  it('decodes UTF-8 strictly and rejects malformed bytes', () => {
    expect(decodeCsvUtf8(new TextEncoder().encode('\uFEFF日本語😀'))).toBe('日本語😀');
    expect(() => decodeCsvUtf8(new Uint8Array([0xc3, 0x28]))).toThrow('不正なUTF-8');
  });
  it('rejects excessive rows and fields before building the full result', () => {
    expect(() => parseCsv('v\n'.repeat(10002))).toThrow('行数上限');
    expect(() => parseCsv(','.repeat(4096))).toThrow('列数上限');
    expect(parseCsv('v\n'.repeat(10001))).toHaveLength(10001);
  });
  it('rejects unpaired surrogates instead of silently replacing them during UTF-8 encoding', () => {
    for (const value of ['\ud800', '\udfff']) {
      expect(() => parseCsv(value)).toThrow('Unicode');
      expect(() => roundTrip(value)).toThrow('レコード2・列1');
    }
  });
});

describe('versioned round-trip format', () => {
  it.each([
    null,
    '',
    ' ',
    'NULL',
    '\\N',
    '\\\\N',
    '\\anything',
    '=1',
    '-1',
    '日本語😀',
    'a,"b"\r\nc\nd',
  ])('preserves %j distinctly', (value) => {
    expect(roundTrip(value)).toBe(value);
  });
  it('handles ordered columns including duplicate names and header-only output', () => {
    const columns = [textColumn, { ...textColumn, nullable: false }];
    const file = encodeRoundTrip(columns, [
      [null, ''],
      ['', '\\N'],
    ]);
    expect(decodeRoundTrip(file.csv, file.metadata).rows).toEqual([
      [null, ''],
      ['', '\\N'],
    ]);
    const empty = encodeRoundTrip(columns, []);
    expect(decodeRoundTrip(empty.csv, empty.metadata).rows).toEqual([]);
  });
  it('rejects unknown versions, formats, types, precision and unsafe metadata', () => {
    const file = encodeRoundTrip([textColumn], [['x']]);
    for (const change of [
      { version: 2 },
      { encoding: 'shift-jis' },
      { nullEncoding: 'other' },
      { rowCount: -1 },
      { columns: [{ ...textColumn, type: { kind: 'money' } }] },
      { columns: [{ ...textColumn, type: { kind: 'decimal', precision: 10, scale: 11 } }] },
    ]) {
      expect(() => readMetadata({ ...file.metadata, ...change })).toThrow();
    }
    expect(() => readMetadata(null)).toThrow();
  });
  it('rejects column count/order, wrong row count, invalid escape and forbidden NULL', () => {
    const file = encodeRoundTrip([textColumn], [['x']]);
    expect(() => decodeRoundTrip(writeCsv([['other'], ['x']]), file.metadata)).toThrow('列順');
    expect(() => decodeRoundTrip(writeCsv([['text'], ['x'], ['y']]), file.metadata)).toThrow(
      '行数',
    );
    expect(() => decodeRoundTrip(writeCsv([['text'], ['\\oops']]), file.metadata)).toThrow(
      'エスケープ',
    );
    expect(() => encodeRoundTrip([{ ...textColumn, nullable: false }], [[null]])).toThrow('NULL');
    expect(() => encodeRoundTrip([textColumn], [['x', 'y']])).toThrow('列数');
  });
});

describe('lossless type validation', () => {
  it.each(['-9223372036854775808', '9223372036854775807'])(
    'preserves signed 64-bit %s',
    (value) => {
      expect(roundTrip(value, { kind: 'integer', bits: 64, signed: true })).toBe(value);
    },
  );
  it('preserves unsigned 64-bit values and rejects overflow and implicit conversion', () => {
    const type: CsvValueType = { kind: 'integer', bits: 64, signed: false };
    expect(roundTrip('18446744073709551615', type)).toBe('18446744073709551615');
    for (const value of ['18446744073709551616', '-1', '1.0', '1e3', ' 1', '01'])
      expect(() => roundTrip(value, type)).toThrow('integer');
  });
  it('preserves decimal precision and trailing zeroes without rounding', () => {
    const value = '-123456789012345678901234567890.123456789000';
    expect(roundTrip(value, { kind: 'decimal', precision: 42, scale: 12 })).toBe(value);
    for (const value of ['1000.00', '1.001', '1e2', 'NaN'])
      expect(() => roundTrip(value, { kind: 'decimal', precision: 5, scale: 2 })).toThrow(
        'decimal',
      );
    expect(roundTrip('0.12', { kind: 'decimal', precision: 2, scale: 2 })).toBe('0.12');
  });
  it.each([
    '2024-02-29T23:59:59.1234567+14:00',
    '2024-01-01T00:00:00.0000001-12:30',
    '2024-01-01T00:00:00Z',
  ])('preserves offset and subsecond precision in %s', (value) => {
    expect(roundTrip(value, { kind: 'datetimeOffset', fractionalDigits: 7 })).toBe(value);
    expect(() => roundTrip(value, { kind: 'datetime', fractionalDigits: 7 })).toThrow('datetime');
  });
  it('rejects invalid dates, offsets and precision loss without timezone normalization', () => {
    for (const value of [
      '2023-02-29T12:00:00+09:00',
      '2024-01-01T24:00:00Z',
      '2024-01-01T00:00:00+14:01',
      '2024-01-01T00:00:00',
      '2024-01-01T00:00:00.12345678Z',
    ])
      expect(() => roundTrip(value, { kind: 'datetimeOffset', fractionalDigits: 7 })).toThrow();
    expect(roundTrip('2000-02-29', { kind: 'date' })).toBe('2000-02-29');
    expect(() => roundTrip('1900-02-29', { kind: 'date' })).toThrow();
    expect(roundTrip('2024-01-01T12:00:00.123456', { kind: 'datetime', fractionalDigits: 6 })).toBe(
      '2024-01-01T12:00:00.123456',
    );
    expect(() =>
      roundTrip('2024-01-01T00:00:00.123Z', { kind: 'datetimeOffset', fractionalDigits: 2 }),
    ).toThrow();
  });
  it('validates booleans, binary length and Unicode text length', () => {
    expect(roundTrip('false', { kind: 'boolean' })).toBe('false');
    expect(() => roundTrip('0', { kind: 'boolean' })).toThrow();
    expect(roundTrip('00fFA0', { kind: 'binary', maxBytes: 3 })).toBe('00fFA0');
    expect(() => roundTrip('0FF', { kind: 'binary' })).toThrow();
    expect(() => roundTrip('00FF', { kind: 'binary', maxBytes: 1 })).toThrow();
    expect(roundTrip('😀', { kind: 'text', maxLength: 1 })).toBe('😀');
    expect(() => roundTrip('😀a', { kind: 'text', maxLength: 1 })).toThrow();
  });
  it('checks imported values as well as exported values and reports exact cell positions', () => {
    const file = encodeRoundTrip(
      [textColumn, { ...textColumn, type: { kind: 'integer', bits: 8, signed: true } }],
      [['a', '1']],
    );
    try {
      decodeRoundTrip(
        writeCsv([
          ['text', 'text'],
          ['a', '128'],
        ]),
        file.metadata,
      );
      throw new Error('expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(CsvDataError);
      expect((error as CsvDataError).record).toBe(2);
      expect((error as CsvDataError).column).toBe(2);
    }
  });
});
