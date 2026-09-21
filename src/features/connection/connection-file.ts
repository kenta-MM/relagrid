import type { ConnectionConfig } from '@/domain/database';

export function parseConnectionFile(text: string): ConnectionConfig {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('接続ファイルは有効なJSONで指定してください。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('接続情報を含むJSONオブジェクトを指定してください。');
  }
  const data = value as Record<string, unknown>;
  for (const key of ['host', 'database', 'username'] as const) {
    if (typeof data[key] !== 'string' || !data[key].trim()) {
      throw new Error(`${key}には空でない文字列を指定してください。`);
    }
  }
  if (!Number.isInteger(data.port) || Number(data.port) < 1 || Number(data.port) > 65535) {
    throw new Error('portには1〜65535の整数を指定してください。');
  }
  if (data.password !== undefined && typeof data.password !== 'string') {
    throw new Error('passwordには文字列を指定してください。');
  }
  if (data.group !== undefined && typeof data.group !== 'string') {
    throw new Error('groupには文字列を指定してください。');
  }
  if (data.readOnly !== undefined && typeof data.readOnly !== 'boolean') {
    throw new Error('readOnlyにはtrueまたはfalseを指定してください。');
  }
  return {
    host: (data.host as string).trim(),
    port: data.port as number,
    database: (data.database as string).trim(),
    username: data.username as string,
    password: (data.password as string | undefined) ?? '',
    group: (data.group as string | undefined)?.trim() || undefined,
    readOnly: (data.readOnly as boolean | undefined) ?? true,
  };
}
