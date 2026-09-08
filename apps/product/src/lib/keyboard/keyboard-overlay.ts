/** Open overlays own keyboard dismissal, even when focus remains on their trigger. */
export function hasOpenKeyboardOverlay(): boolean {
  return [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ),
  ].some(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"], [data-state="closed"]'),
  );
}
