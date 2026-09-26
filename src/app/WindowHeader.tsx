import type { ReactNode } from 'react';
import { Box, Minus, Square, X } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function WindowHeader({ children }: { children: ReactNode }) {
  const desktop = isTauri();
  async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (!desktop) return;
    try {
      await getCurrentWindow()[action]();
    } catch (error) {
      console.error('ウィンドウ操作に失敗しました', error);
    }
  }

  return (
    <header className="window-header" data-tauri-drag-region>
      <div className="window-brand" data-tauri-drag-region>
        <Box size={21} />
        <span>RelaGrid</span>
      </div>
      {children}
      <div className="window-controls">
        <button
          aria-label="最小化"
          title="最小化"
          disabled={!desktop}
          onClick={() => void windowAction('minimize')}
        >
          <Minus size={16} />
        </button>
        <button
          aria-label="最大化 / 元に戻す"
          title="最大化 / 元に戻す"
          disabled={!desktop}
          onClick={() => void windowAction('toggleMaximize')}
        >
          <Square size={12} />
        </button>
        <button
          className="window-close"
          aria-label="ウィンドウを閉じる"
          title="閉じる"
          disabled={!desktop}
          onClick={() => void windowAction('close')}
        >
          <X size={17} />
        </button>
      </div>
    </header>
  );
}
