import type { BillingAccess } from '@dayopt/billing';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingAccessProvider, useBillingAccess } from './BillingAccessProvider';
const state = vi.hoisted(() => ({
  access: {
    state: 'trial',
    canUseProduct: true,
    trialEndsAt: '2026-09-08T00:01:00Z',
    enforced: true,
  } as BillingAccess,
  isError: false,
  isIdle: true,
  mutate: vi.fn(),
  refetch: vi.fn(),
}));
const utils = {
  billing: { getAccess: { setData: vi.fn() }, getOverview: { invalidate: vi.fn() } },
};
vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => utils,
    billing: {
      getAccess: {
        useQuery: () => ({ data: state.access, isError: state.isError, refetch: state.refetch }),
      },
      startTrial: {
        useMutation: () => ({
          isIdle: state.isIdle,
          isError: false,
          mutate: state.mutate,
          reset: vi.fn(),
        }),
      },
    },
  },
}));
function Editor() {
  const access = useBillingAccess();
  return (
    <>
      <input aria-label="draft" defaultValue="" />
      <button disabled={!access.canUseProduct}>save</button>
      <span>{access.state}</span>
    </>
  );
}
describe('application trial lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    vi.clearAllMocks();
    state.access = {
      state: 'trial',
      canUseProduct: true,
      trialEndsAt: '2026-09-08T00:01:00Z',
      enforced: true,
    };
    state.isError = false;
    state.isIdle = true;
  });
  afterEach(() => vi.useRealTimers());
  it('starts once from the authenticated app mount', () => {
    state.access = {
      state: 'not_started',
      canUseProduct: false,
      trialEndsAt: null,
      enforced: true,
    };
    state.mutate.mockImplementation(() => {
      state.isIdle = false;
    });
    const view = render(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    view.rerender(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
  it('closes writes at the exact deadline and retains the input', () => {
    render(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved draft' } });
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('unsaved draft');
    expect(screen.getByText('expired')).toBeInTheDocument();
  });
  it('retains mounted input through a failed refresh and later subscription', () => {
    const view = render(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } });
    state.isError = true;
    view.rerender(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    expect(screen.getByRole('textbox')).toHaveValue('keep me');
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    state.isError = false;
    state.access = { state: 'subscribed', canUseProduct: true, trialEndsAt: null, enforced: true };
    view.rerender(
      <BillingAccessProvider>
        <Editor />
      </BillingAccessProvider>,
    );
    expect(screen.getByRole('textbox')).toHaveValue('keep me');
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  });
});
