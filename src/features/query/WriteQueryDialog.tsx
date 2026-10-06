import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function WriteQueryDialog({
  target,
  sql,
  confirm,
  cancel,
}: {
  target: string;
  sql: string;
  confirm(): void;
  cancel(): void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogTitle>読み書き接続のSQL実行確認</DialogTitle>
        <DialogDescription>
          接続先: {target}。本番環境を含め、接続先とSQLを確認してください。
          更新は自動コミットされ、アプリから取り消せません。
          WHEREなしのUPDATE・DELETE、DROP・TRUNCATE等はデータを失う可能性があります。
          読み書き接続では複数文は実行できません。
        </DialogDescription>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm">{sql}</pre>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={cancel}>
            キャンセル
          </Button>
          <Button onClick={confirm}>接続先とSQLを確認して実行</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
