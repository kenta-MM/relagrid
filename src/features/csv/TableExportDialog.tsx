import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { Table } from '@/domain/database';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export function TableExportDialog({ table, close }: { table: Table; close(): void }) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState(0);
  const [message, setMessage] = useState('');
  const job = useRef<{ id?: string; cancelled: boolean } | null>(null);
  function cancel() {
    const current = job.current;
    if (!current) return;
    current.cancelled = true;
    if (current.id)
      void invoke('abort_csv_export', { id: current.id }).catch(() => {
        setMessage('中断の要求に失敗しました。出力結果を確認してください');
      });
  }
  useEffect(() => () => cancel(), []);
  async function start() {
    if (job.current) return;
    const current: { id?: string; cancelled: boolean } = { cancelled: false };
    job.current = current;
    setRunning(true);
    setRows(0);
    setMessage('保存先を選択してください');
    try {
      const id = await invoke<string | null>('begin_csv_export', { name: `${table.name}.csv` });
      if (!id) {
        setMessage('保存を取り消しました');
        return;
      }
      current.id = id;
      if (current.cancelled) {
        await invoke('abort_csv_export', { id });
        setMessage('出力を中断しました');
        return;
      }
      const progress = new Channel<{ rows: number }>();
      progress.onmessage = (value) => setRows(value.rows);
      setMessage('テーブルから取得して書き出しています');
      const count = await invoke<number>('export_table_csv', { id, tableId: table.id, progress });
      setRows(count);
      setMessage(`${count}件の保存が完了しました`);
    } catch (error) {
      setMessage(`保存できませんでした: ${String(error)}`);
      if (current.id) {
        try {
          await invoke('abort_csv_export', { id: current.id });
        } catch {
          setMessage('保存に失敗し、一時ファイルの削除も確認できませんでした');
        }
      }
    } finally {
      job.current = null;
      setRunning(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !job.current) close();
      }}
    >
      <DialogContent>
        <DialogTitle>テーブルの全件CSV出力</DialogTitle>
        <DialogDescription>
          {table.schema}.{table.name}
          を新たに読み取り、全件保存します。プレビューの100件制限は適用しません。
        </DialogDescription>
        <div className="my-4 space-y-3 text-sm">
          <p>列数: {table.columns.length}。総件数は取得完了時に確定します。行順は保証しません。</p>
          <p>
            汎用CSV（UTF-8
            BOM・ヘッダーあり・カンマ区切り・CRLF）。NULLは空文字、バイナリは16進表現、数式に見える値にはアポストロフィを付けます。TIMESTAMPはUTCで出力します。
          </p>
          <p>
            型保持形式は未対応です。出力上限は10分・512列、値あたり
            {Math.min(
              1048576,
              Math.floor(8388608 / Math.max(1, table.columns.length)),
            ).toLocaleString()}
            バイトです。上限を超えた場合は保存を確定せず終了します。
          </p>
          <p role="status" aria-live="polite">
            {message || '保存先を選んで開始してください'}（書き込み済み{rows}件）
          </p>
        </div>
        <div className="flex justify-end gap-2">
          {running ? (
            <Button
              variant="outline"
              onClick={() => {
                cancel();
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
              <Button onClick={() => void start()}>保存先を選んで全件出力</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
