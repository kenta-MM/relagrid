import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Preview } from '@/domain/database';
import { exportGenericCsv } from './csv';

export interface CsvSink {
  write(text: string): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}
export const EXPORT_CHUNK_BYTES = 64 * 1024;

// The existing result is retained by its editor. Export allocates only one row and one chunk.
export async function streamGenericCsv(
  source: Preview,
  sink: CsvSink,
  signal: AbortSignal,
  progress: (rows: number) => void,
): Promise<void> {
  const check = () => {
    if (signal.aborted) throw new DOMException('出力を中断しました', 'AbortError');
  };
  try {
    for (let row = -1; row < source.rows.length; row++) {
      check();
      const text =
        row === -1
          ? exportGenericCsv({ columns: source.columns, rows: [] })
          : '\r\n' +
            exportGenericCsv({
              columns: source.rows[row].map((value) => value ?? ''),
              rows: [],
            }).slice(1);
      // Split on Unicode characters, never inside a surrogate pair.
      let chunk = '';
      let bytes = 0;
      for (const character of text) {
        const point = character.codePointAt(0)!;
        const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (bytes + size > EXPORT_CHUNK_BYTES) {
          check();
          await sink.write(chunk);
          chunk = '';
          bytes = 0;
        }
        chunk += character;
        bytes += size;
      }
      check();
      if (chunk) await sink.write(chunk);
      progress(row + 1);
      // Let paint and cancellation run even with an immediately resolved sink.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    check();
    await sink.finish();
  } catch (error) {
    try {
      await sink.abort();
    } catch {
      throw new Error(
        '出力に失敗し、一時ファイルの削除も確認できませんでした。完成ファイルは確定していません。',
      );
    }
    throw error;
  }
}

export async function openCsvSink(name: string): Promise<CsvSink | null> {
  if (isTauri()) {
    const id = await invoke<string | null>('begin_csv_export', { name });
    if (!id) return null;
    return {
      write: (text) => invoke('write_csv_export', { id, text }),
      finish: () => invoke('finish_csv_export', { id }),
      abort: () => invoke('abort_csv_export', { id }),
    };
  }
  // Browser demo only: bounded query results, no filesystem completion guarantee.
  const parts: BlobPart[] = [];
  return {
    async write(text) {
      parts.push(text);
    },
    async abort() {
      parts.length = 0;
    },
    async finish() {
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      parts.length = 0;
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
