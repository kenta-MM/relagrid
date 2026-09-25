import { describe, expect, it, vi } from 'vitest';
import { exportGenericCsv } from './csv';
import { EXPORT_CHUNK_BYTES, streamGenericCsv, type CsvSink } from './export';

function output() {
  const chunks: string[] = [];
  const sink: CsvSink = {
    write: vi.fn(async (text) => {
      chunks.push(text);
    }),
    finish: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return { sink, chunks };
}
describe('incremental CSV export', () => {
  it('matches the existing CSV bytes including BOM, quoting, NULL, formulas and multiline values', async () => {
    const source = {
      columns: ['a', 'b'],
      rows: [
        [null, ''],
        ['a,"b"\r\nc', '日本語😀'],
        ["O'Brien", '=1'],
      ],
    };
    const { sink, chunks } = output();
    const progress = vi.fn();
    await streamGenericCsv(source, sink, new AbortController().signal, progress);
    expect(chunks.join('')).toBe(exportGenericCsv(source));
    expect(progress.mock.calls.map(([rows]) => rows)).toEqual([0, 1, 2, 3]);
    expect(sink.finish).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
  });
  it('bounds chunks by UTF-8 bytes without breaking Unicode or retaining previous chunks', async () => {
    const source = { columns: ['v'], rows: [['😀日'.repeat(30000)]] };
    let bytes = 0;
    let calls = 0;
    const sink: CsvSink = {
      async write(text) {
        const encoded = new TextEncoder().encode(text);
        expect(encoded.length).toBeLessThanOrEqual(EXPORT_CHUNK_BYTES);
        expect(new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(encoded)).toBe(
          text,
        );
        bytes += encoded.length;
        calls++;
      },
      async finish() {},
      async abort() {},
    };
    await streamGenericCsv(source, sink, new AbortController().signal, () => {});
    expect(calls).toBeGreaterThan(3);
    expect(bytes).toBe(new TextEncoder().encode(exportGenericCsv(source)).length);
  });
  it('cancels after an acknowledged write without publishing a completed file', async () => {
    const { sink } = output();
    const controller = new AbortController();
    await expect(
      streamGenericCsv(
        { columns: ['v'], rows: [['1'], ['2']] },
        sink,
        controller.signal,
        (rows) => {
          if (rows === 1) controller.abort();
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.finish).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it.each(['write', 'finish'] as const)(
    'cleans up after %s fails, including disk errors',
    async (method) => {
      const { sink } = output();
      sink[method] = vi.fn().mockRejectedValue(new Error('disk full'));
      await expect(
        streamGenericCsv(
          { columns: ['v'], rows: [['1']] },
          sink,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow('disk full');
      expect(sink.abort).toHaveBeenCalledOnce();
      if (method === 'write') expect(sink.finish).not.toHaveBeenCalled();
    },
  );
  it('exports a header-only result and stops an already cancelled export before its first write', async () => {
    const { sink, chunks } = output();
    await streamGenericCsv(
      { columns: ['v'], rows: [] },
      sink,
      new AbortController().signal,
      () => {},
    );
    expect(chunks.join('')).toBe('\uFEFF"v"');
    const cancelled = output();
    await expect(
      streamGenericCsv({ columns: ['v'], rows: [] }, cancelled.sink, AbortSignal.abort(), () => {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.sink.write).not.toHaveBeenCalled();
  });
});
