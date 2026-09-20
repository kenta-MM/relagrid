import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: string[];
  onAdd(name: string): void;
}

export function GroupDialog({ open, onOpenChange, groups, onAdd }: Props) {
  const [name, setName] = useState('');
  const group = name.trim();
  const duplicate = groups.includes(group);
  function changeOpen(value: boolean) {
    setName('');
    onOpenChange(value);
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogTitle className="text-xl font-semibold">グループを追加</DialogTitle>
        <DialogDescription className="mt-2 mb-6 text-sm text-muted-foreground">
          空のグループを作成します。あとから接続をドラッグして配置できます。
        </DialogDescription>
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!group || duplicate) return;
            onAdd(group);
            changeOpen(false);
          }}
        >
          <label>
            グループ名
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例：本番環境"
              required
            />
          </label>
          {duplicate && (
            <p role="alert" className="error-message">
              同じ名前のグループがすでにあります。
            </p>
          )}
          <Button type="submit" disabled={!group || duplicate}>
            追加
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
