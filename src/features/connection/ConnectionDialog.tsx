import { useState, type FormEvent } from 'react';
import { Database, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ConnectionConfig } from '@/domain/database';
interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConnect(config: ConnectionConfig): Promise<void>;
}
export function ConnectionDialog({ open, onOpenChange, onConnect }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      });
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
          onOpenChange(value);
        }
      }}
    >
      <DialogContent
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
          ローカルのデータベースを読み取り専用で探索します。
        </DialogDescription>
        <form onSubmit={submit} className="connection-form">
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
            ユーザー名
            <input name="username" defaultValue="root" autoComplete="username" required />
          </label>
          <label>
            パスワード
            <input name="password" type="password" autoComplete="current-password" />
          </label>
          <p className="text-xs text-muted-foreground">
            パスワードはファイルに保存されません。SELECT権限のあるユーザーを指定してください。
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
