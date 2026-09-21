import { useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { Database, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ConnectionConfig } from '@/domain/database';
import { parseConnectionFile } from './connection-file';
interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConnect(config: ConnectionConfig): Promise<void>;
}
export function ConnectionDialog({ open, onOpenChange, onConnect }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > 64 * 1024) throw new Error('接続ファイルは64KB以下にしてください。');
      const config = parseConnectionFile(await file.text());
      if (!formRef.current) return;
      for (const [key, value] of Object.entries(config)) {
        const input = formRef.current.elements.namedItem(key);
        if (!(input instanceof HTMLInputElement)) continue;
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = String(value ?? '');
      }
      setFileName(file.name);
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続ファイルを読み込めませんでした。');
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await onConnect({
        host: String(form.get('host')).trim(),
        port: Number(form.get('port')),
        username: String(form.get('username')),
        password: String(form.get('password')),
        database: String(form.get('database')).trim(),
        group: String(form.get('group') ?? '').trim() || undefined,
        readOnly: form.get('readOnly') === 'on',
      });
      setFileName('');
      onOpenChange(false);
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setError('');
          setFileName('');
          onOpenChange(value);
        }
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-32px)] overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <div className="dialog-icon">
          <Database size={23} />
        </div>
        <DialogTitle className="text-xl font-semibold">MySQLに接続</DialogTitle>
        <DialogDescription className="mt-2 mb-6 text-sm text-muted-foreground">
          データベースと、この接続での読み取りモードを設定します。
        </DialogDescription>
        <form ref={formRef} onSubmit={submit} className="connection-form">
          <label>
            接続ファイルを読み込む（JSON）
            <input
              type="file"
              accept=".json,application/json"
              onChange={importFile}
              disabled={busy}
            />
          </label>
          {fileName && (
            <p role="status" className="text-xs text-muted-foreground">
              {fileName} を読み込みました。接続内容を確認してください。
            </p>
          )}
          <div className="form-pair">
            <label>
              ホスト
              <input name="host" defaultValue="127.0.0.1" required />
            </label>
            <label>
              ポート
              <input name="port" type="number" defaultValue="3306" min="1" max="65535" required />
            </label>
          </div>
          <label>
            データベース名
            <input name="database" placeholder="例：sales" required />
          </label>
          <label>
            グループ名（任意）
            <input name="group" placeholder="例：本番環境（未入力ならグループ化しません）" />
          </label>
          <label>
            ユーザー名
            <input name="username" defaultValue="root" autoComplete="username" required />
          </label>
          <label>
            パスワード
            <input name="password" type="password" autoComplete="current-password" />
          </label>
          <label className="read-only-option">
            <input name="readOnly" type="checkbox" defaultChecked />
            読み取り専用
          </label>
          <p className="text-xs text-muted-foreground">
            チェックを外すと更新SQLを実行できます（DBユーザーの権限内）。読み込んだ接続情報をアプリが自動保存することはありません。
          </p>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="w-full mt-2">
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Database size={16} />}
            {busy ? '接続中…' : '接続してスキーマを読み込む'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
