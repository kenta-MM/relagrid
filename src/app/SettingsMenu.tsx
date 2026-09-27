import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  defaultShortcuts,
  keyBinding,
  saveShortcuts,
  shortcutConflict,
  shortcutDefinitions,
  shortcutIds,
  shortcutLabel,
  useShortcuts,
} from '@/lib/shortcut-settings';

export function SettingsMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<'General' | 'Short cut key' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shortcuts = useShortcuts();
  const [draft, setDraft] = useState(shortcuts);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!menuOpen) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);
  function open(next: 'General' | 'Short cut key') {
    setDraft(shortcuts);
    setError('');
    setMenuOpen(false);
    setSection(next);
  }
  const conflict = shortcutConflict(draft);
  return (
    <div
      className="settings-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setMenuOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        aria-expanded={menuOpen}
        aria-controls="settings-options"
        onClick={() => setMenuOpen((value) => !value)}
      >
        settings
      </button>
      {menuOpen && (
        <div id="settings-options" className="settings-options" aria-label="settings">
          <button onClick={() => open('General')}>General</button>
          <button onClick={() => open('Short cut key')}>Short cut key</button>
        </div>
      )}
      <Dialog
        open={section !== null}
        onOpenChange={(value) => {
          if (!value) setSection(null);
        }}
      >
        <DialogContent
          className="settings-dialog"
          onEscapeKeyDown={(event) => {
            if (document.activeElement?.matches('.shortcut-row input')) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle className="text-xl font-semibold">{section}</DialogTitle>
          <DialogDescription className="my-3 text-sm text-muted-foreground">
            {section === 'General'
              ? 'RelaGrid の一般情報です。'
              : '入力欄を選び、設定したいキーを押してください。Ctrl と Cmd は共通の割り当てです。'}
          </DialogDescription>
          {section === 'General' ? (
            <p>
              RelaGrid 0.1.0
              <br />
              ショートカット設定はこの端末に保存されます。
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                サイドバーの「開く」「閉じる」に同じキーを設定すると、押すたびに開閉します。Escape
                は入力を取り消します。SQL操作はSQL画面内で有効です。
              </p>
              <div className="shortcut-list">
                {shortcutIds.map((id) => (
                  <div className="shortcut-row" key={id}>
                    <label htmlFor={`shortcut-${id}`}>{shortcutDefinitions[id][0]}</label>
                    <input
                      id={`shortcut-${id}`}
                      readOnly
                      value={shortcutLabel(draft[id])}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Tab' &&
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.altKey
                        )
                          return;
                        if (event.key === 'Escape') {
                          event.currentTarget.blur();
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        if (
                          event.nativeEvent.isComposing ||
                          event.nativeEvent.keyCode === 229 ||
                          event.repeat ||
                          event.getModifierState('AltGraph')
                        )
                          return;
                        const binding = keyBinding(event);
                        if (binding) {
                          setDraft((values) => ({ ...values, [id]: binding }));
                          setError('');
                        }
                      }}
                    />
                    <button
                      aria-label={`${shortcutDefinitions[id][0]}を解除`}
                      onClick={() => setDraft((values) => ({ ...values, [id]: '' }))}
                    >
                      解除
                    </button>
                  </div>
                ))}
              </div>
              {(conflict || error) && (
                <p role="alert" className="error-message">
                  {conflict || error}
                </p>
              )}
              <div className="settings-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft({ ...defaultShortcuts });
                    setError('');
                  }}
                >
                  初期設定に戻す
                </Button>
                <Button variant="outline" onClick={() => setSection(null)}>
                  キャンセル
                </Button>
                <Button
                  disabled={!!conflict}
                  onClick={() => {
                    try {
                      saveShortcuts(draft);
                      setSection(null);
                    } catch {
                      setError(
                        '設定を保存できませんでした。端末のストレージ設定を確認してください。',
                      );
                    }
                  }}
                >
                  保存
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
