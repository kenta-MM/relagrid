// Keep workspace commands out of dialogs, IME composition and unrelated form fields.
export function shortcutTarget(event: KeyboardEvent): Element | null {
  const target = event.target instanceof Element ? event.target : null;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState('AltGraph') ||
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]') ||
    target?.closest('[role="dialog"], [role="alertdialog"]') ||
    (target?.closest('input, textarea, select, [contenteditable="true"]') &&
      !target.closest('.sql-code-editor'))
  )
    return null;
  return target;
}

export function claimShortcut(event: KeyboardEvent, action: () => void) {
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) action();
}
