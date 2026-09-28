import { useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function CloseQueryDialog({
  name,
  confirm,
  cancel,
}: {
  name: string;
  confirm(): void;
  cancel(): void;
}) {
  const okButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          okButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLElement>(
              '.sql-code-editor [contenteditable="true"], .sql-code-editor textarea',
            )
            ?.focus();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            (document.activeElement === okButton.current
              ? cancelButton
              : okButton
            ).current?.focus();
          }
        }}
      >
        <DialogTitle className="text-xl font-semibold">クエリを閉じる</DialogTitle>
        <DialogDescription className="mt-2 mb-6 text-sm text-muted-foreground">
          {name}の変更が保存されていませんが閉じますか？ 閉じると未保存の変更内容が失われます。
        </DialogDescription>
        <div className="flex justify-end gap-3">
          <Button
            ref={okButton}
            className="focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onPointerMove={() => okButton.current?.focus()}
            onClick={confirm}
          >
            OK
          </Button>
          <Button
            ref={cancelButton}
            variant="outline"
            className="focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onPointerMove={() => cancelButton.current?.focus()}
            onClick={cancel}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
