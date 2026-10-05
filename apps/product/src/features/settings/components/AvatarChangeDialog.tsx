'use client';

import { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AvatarUpload } from '@/components/ui/inputs/avatar-upload';
import { useAuthStore } from '@/features/auth';
import { logger } from '@/lib/logger';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { deleteAvatar, uploadAvatar } from '@/lib/supabase/storage';
import { api } from '@/lib/trpc';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@dayopt/components';

interface AvatarChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * アバター変更ダイアログ
 */
export function AvatarChangeDialog({ open, onOpenChange }: AvatarChangeDialogProps) {
  const t = useTranslations();
  const user = useAuthStore((state) => state.user);
  const userId = user?.id;
  const supabase = createClient();
  const updateProfile = api.userSettings.updateProfile.useMutation();

  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    user?.user_metadata?.avatar_url || null,
  );
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!userId) return;

      setIsUploading(true);
      try {
        const publicUrl = await uploadAvatar(file, userId);

        await updateProfile.mutateAsync({ avatarUrl: publicUrl });

        const { error } = await observeAuthOperation('update_avatar_metadata', () =>
          supabase.auth.updateUser({ data: { avatar_url: publicUrl } }),
        );
        if (error) throw error;
        setAvatarUrl(publicUrl);
      } catch (error) {
        logger.error('Avatar upload error:', error);
        throw error;
      } finally {
        setIsUploading(false);
      }
    },
    [userId, updateProfile, supabase],
  );

  const handleRemove = useCallback(async () => {
    if (!userId) return;

    setIsUploading(true);
    try {
      await updateProfile.mutateAsync({ avatarUrl: null });

      const { error } = await observeAuthOperation('remove_avatar_metadata', () =>
        supabase.auth.updateUser({ data: { avatar_url: null } }),
      );
      if (error) throw error;
      setAvatarUrl(null);
      // 保存済みの参照を解除してから回収する。更新失敗時は参照先の画像を残す。
      await deleteAvatar(userId);
    } catch (error) {
      logger.error('Avatar delete error:', error);
      throw error;
    } finally {
      setIsUploading(false);
    }
  }, [userId, updateProfile, supabase]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.account.profilePicture')}</DialogTitle>
          <DialogDescription>{t('settings.account.profilePictureDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex justify-center py-6">
          <AvatarUpload
            currentAvatarUrl={avatarUrl}
            onUpload={handleUpload}
            onRemove={handleRemove}
            loading={isUploading}
            size="3xl"
          />
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>{t('common.actions.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
