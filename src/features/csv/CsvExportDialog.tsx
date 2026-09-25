import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { QueryResultSet } from '@/domain/database';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { openCsvSink, streamGenericCsv } from './export';

export interface ExportSelection {
  result: QueryResultSet;
  name: string;
  label: string;
}

export function CsvExportDialog({
  selection,
  close,
}: {
  selection: ExportSelection;
  close(): void;
}) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState(0);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function start() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setRows(0);
    setMessage('保存先を選択してください');
    try {
      const sink = await openCsvSink(selection.name);
      if (!sink) {
        setMessage('保存を取り消しました');
        return;
      }
      setMessage('書き出しています');
      await streamGenericCsv(selection.result, sink, abort.signal, setRows);
      setMessage(
        isTauri()
          ? `${selection.result.rows.length}件の保存が完了しました`
          : 'ダウンロードを開始しました。保存結果はブラウザで確認してください',
      );
    } catch (error) {
      setMessage(
        error instanceof DOMException && error.name === 'AbortError'
          ? '出力を中断しました。完成ファイルは変更していません'
          : `保存できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      controller.current = null;
      setRunning(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !controller.current) close();
      }}
    >
      <DialogContent>
        <DialogTitle>CSVエクスポート</DialogTitle>
        <DialogDescription>
          {selection.label}の取得済み行を保存します。SQLの再実行は行いません。
        </DialogDescription>
        <div className="my-4 space-y-3 text-sm">
          <p>
            出力対象: {selection.result.rows.length}件 / {selection.result.columns.length}
            列（全ページ）
          </p>
          {(selection.result.truncated || !selection.result.complete) && (
            <p role="note">
              省略または取得未完了の結果です。全件出力ではありません。表示上限で切れた値も元に戻せません。
            </p>
          )}
          <p>形式: 汎用CSV（UTF-8 BOM付き・ヘッダーあり・カンマ区切り・CRLF）</p>
          <p>NULLは空文字になります。数式として解釈されうる値にはアポストロフィを付けます。</p>
          <p>型保持形式は未対応です。この結果には型・精度の情報が揃っていません。</p>
          {!isTauri() && (
            <p>
              ブラウザのデモではダウンロードのみ対応します。ディスクへの保存完了は確認できません。
            </p>
          )}
          <progress
            aria-label="CSV出力の進捗"
            max={Math.max(1, selection.result.rows.length)}
            value={rows}
            className="w-full"
          />
          <p role="status" aria-live="polite">
            {message || '保存先を選んで開始してください'}（{rows} / {selection.result.rows.length}
            件）
          </p>
        </div>
        <div className="flex justify-end gap-2">
          {running ? (
            <Button
              variant="outline"
              onClick={() => {
                controller.current?.abort();
                setMessage('中断しています');
              }}
            >
              中断
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                閉じる
              </Button>
              <Button onClick={() => void start()}>保存先を選んで出力</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
