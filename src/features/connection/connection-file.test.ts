import { describe, expect, it } from 'vitest';
import { parseConnectionFile } from './connection-file';

const base = { host: 'localhost', port: 3306, database: 'sample', username: 'reader' };
describe('connection file', () => {
  it('accepts BOM and defaults to read-only without a password', () => {
    expect(parseConnectionFile('\uFEFF' + JSON.stringify(base))).toEqual({
      ...base,
      password: '',
      readOnly: true,
      tlsEnabled: false,
      group: undefined,
    });
  });
  it('preserves credentials and explicit access mode', () => {
    const config = { ...base, password: '  secret  ', group: ' local ', readOnly: false };
    expect(parseConnectionFile(JSON.stringify(config))).toEqual({
      ...config,
      group: 'local',
      tlsEnabled: false,
    });
  });
  it.each([
    null,
    [],
    {},
    { ...base, port: 65536 },
    { ...base, port: 1.5 },
    { ...base, port: '3306' },
    { ...base, readOnly: 'false' },
    { ...base, host: ' ' },
    { ...base, password: 123 },
    { ...base, group: [] },
    { ...base, tlsEnabled: 'false' },
    { ...base, tlsCaPem: 123 },
    { ...base, tlsCaPem: '-----BEGIN PRIVATE KEY-----' },
    { ...base, tlsCaPem: 'a'.repeat(65537) },
  ])('rejects invalid structure or field types: %j', (value) => {
    expect(() => parseConnectionFile(JSON.stringify(value))).toThrow();
  });
  it('does not expose file contents in JSON errors', () => {
    expect(() => parseConnectionFile('{"password":"private')).toThrow(
      '接続ファイルは有効なJSONで指定してください。',
    );
  });
  it.each([true, false])('preserves explicit TLS setting: %s', (tlsEnabled) => {
    expect(parseConnectionFile(JSON.stringify({ ...base, tlsEnabled })).tlsEnabled).toBe(
      tlsEnabled,
    );
  });
  it('imports a custom CA without changing credentials', () => {
    const tlsCaPem = '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----';
    expect(parseConnectionFile(JSON.stringify({ ...base, tlsCaPem })).tlsCaPem).toBe(tlsCaPem);
  });
});
