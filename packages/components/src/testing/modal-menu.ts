import { expect, userEvent, waitFor, within } from 'storybook/test';

/** 閉じた画面は通常の全体検査、開いたmodal menuはこの範囲と操作契約を組み合わせる。 */
export const OPEN_MENU_A11Y = { context: { include: ['[role="menu"]'] } };

/** 背景へのfocusを拒否し、Escape後はトリガーに戻ることを実操作で確認して再び開く。 */
export async function verifyModalMenuFocus(trigger: HTMLElement) {
  const body = within(trigger.ownerDocument.body);
  const menu = await body.findByRole('menu');
  trigger.focus();
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await userEvent.tab();
  await expect(menu.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  await expect(menu.contains(document.activeElement)).toBe(true);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(trigger);
  await waitFor(() => expect(body.getByRole('menu')).toBeVisible());
  await expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull();
}
