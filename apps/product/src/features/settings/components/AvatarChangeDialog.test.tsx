import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarUpload } from '@/components/ui/inputs/avatar-upload';
import type { ComponentProps } from 'react';

const mocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  updateUser: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
  avatarProps: undefined as ComponentProps<typeof AvatarUpload> | undefined,
}));
const OLD_URL = 'https://example.com/avatar.png';
const NEW_URL = 'https://example.com/avatar.webp';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/features/auth', () => ({
  useAuthStore: (
    selector: (state: { user: { id: string; user_metadata: { avatar_url: string } } }) => unknown,
  ) => selector({ user: { id: 'user-1', user_metadata: { avatar_url: OLD_URL } } }),
}));
vi.mock('@/lib/trpc', () => ({
  api: {
    userSettings: { updateProfile: { useMutation: () => ({ mutateAsync: mocks.updateProfile }) } },
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { updateUser: mocks.updateUser } }),
}));
vi.mock('@/lib/supabase/storage', () => ({
  uploadAvatar: mocks.uploadAvatar,
  deleteAvatar: mocks.deleteAvatar,
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/sentry', () => ({
  observeAuthOperation: (_operation: string, call: () => Promise<unknown>) => call(),
}));
vi.mock('@/components/ui/inputs/avatar-upload', () => ({
  AvatarUpload: (props: ComponentProps<typeof AvatarUpload>) => {
    mocks.avatarProps = props;
    return <output data-testid="avatar-url">{props.currentAvatarUrl ?? 'empty'}</output>;
  },
}));

import { AvatarChangeDialog } from './AvatarChangeDialog';

function renderDialog() {
  render(<AvatarChangeDialog open onOpenChange={vi.fn()} />);
}

async function remove() {
  let failure: unknown;
  await act(async () => {
    try {
      await mocks.avatarProps!.onRemove!();
    } catch (error) {
      failure = error;
    }
  });
  return failure;
}

async function upload() {
  let failure: unknown;
  await act(async () => {
    try {
      await mocks.avatarProps!.onUpload(new File(['image'], 'avatar.webp', { type: 'image/webp' }));
    } catch (error) {
      failure = error;
    }
  });
  return failure;
}

describe('AvatarChangeDialog persistence failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.avatarProps = undefined;
    mocks.updateProfile.mockResolvedValue({});
    mocks.updateUser.mockResolvedValue({ data: {}, error: null });
    mocks.uploadAvatar.mockResolvedValue(NEW_URL);
    mocks.deleteAvatar.mockResolvedValue(undefined);
  });

  it('keeps the referenced image when profile clearing fails', async () => {
    const failure = new Error('profile unavailable');
    let imageExists = true;
    mocks.updateProfile.mockRejectedValue(failure);
    mocks.deleteAvatar.mockImplementation(async () => {
      imageExists = false;
    });
    renderDialog();

    expect(await remove()).toBe(failure);
    expect(mocks.updateProfile).toHaveBeenCalledWith({ avatarUrl: null });
    expect(imageExists).toBe(true);
    expect(screen.getByTestId('avatar-url')).toHaveTextContent(OLD_URL);
    expect(mocks.deleteAvatar).not.toHaveBeenCalled();
  });

  it('surfaces a returned auth failure and keeps the image during removal', async () => {
    const failure = new Error('auth unavailable');
    let imageExists = true;
    mocks.updateUser.mockResolvedValue({ data: {}, error: failure });
    mocks.deleteAvatar.mockImplementation(async () => {
      imageExists = false;
    });
    renderDialog();

    expect(await remove()).toBe(failure);
    expect(mocks.updateUser).toHaveBeenCalledWith({ data: { avatar_url: null } });
    expect(imageExists).toBe(true);
    expect(screen.getByTestId('avatar-url')).toHaveTextContent(OLD_URL);
    expect(mocks.deleteAvatar).not.toHaveBeenCalled();
  });

  it.each(['profile', 'auth'] as const)(
    'does not publish an upload when %s persistence fails',
    async (stage) => {
      const failure = new Error(`${stage} unavailable`);
      if (stage === 'profile') mocks.updateProfile.mockRejectedValue(failure);
      else mocks.updateUser.mockResolvedValue({ data: {}, error: failure });
      renderDialog();

      expect(await upload()).toBe(failure);
      expect(mocks.uploadAvatar).toHaveBeenCalledTimes(1);
      expect(mocks.updateProfile).toHaveBeenCalledWith({ avatarUrl: NEW_URL });
      expect(screen.getByTestId('avatar-url')).toHaveTextContent(OLD_URL);
    },
  );

  it('clears both persisted references before deleting the image', async () => {
    let profileUrl: string | null = OLD_URL;
    let authUrl: string | null = OLD_URL;
    let imageExists = true;
    const referencesAtDeletion: (string | null)[][] = [];
    mocks.updateProfile.mockImplementation(async ({ avatarUrl }: { avatarUrl: string | null }) => {
      profileUrl = avatarUrl;
    });
    mocks.updateUser.mockImplementation(
      async ({ data }: { data: { avatar_url: string | null } }) => {
        authUrl = data.avatar_url;
        return { data: {}, error: null };
      },
    );
    mocks.deleteAvatar.mockImplementation(async () => {
      referencesAtDeletion.push([profileUrl, authUrl]);
      imageExists = false;
    });
    renderDialog();

    expect(await remove()).toBeUndefined();
    expect(referencesAtDeletion).toEqual([[null, null]]);
    expect(imageExists).toBe(false);
    expect(screen.getByTestId('avatar-url')).toHaveTextContent('empty');
  });

  it('keeps the cleared display and reports failure when image collection fails', async () => {
    const failure = new Error('storage unavailable');
    mocks.deleteAvatar.mockRejectedValue(failure);
    renderDialog();

    expect(await remove()).toBe(failure);
    expect(mocks.updateProfile).toHaveBeenCalledWith({ avatarUrl: null });
    expect(mocks.updateUser).toHaveBeenCalledWith({ data: { avatar_url: null } });
    expect(mocks.deleteAvatar).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('avatar-url')).toHaveTextContent('empty');
  });

  it('publishes an upload after both persistence steps succeed', async () => {
    renderDialog();
    expect(await upload()).toBeUndefined();
    expect(mocks.updateUser).toHaveBeenCalledWith({ data: { avatar_url: NEW_URL } });
    expect(screen.getByTestId('avatar-url')).toHaveTextContent(NEW_URL);
    expect(mocks.deleteAvatar).not.toHaveBeenCalled();
  });
});
