'use client';

import { Button } from '@dayopt/components';
import { Copy, Facebook, Link2, Linkedin, Twitter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface ShareButtonProps {
  title: string;
  /** 共有対象の絶対 URL。SSR と CSR で一致させるためサーバから渡す（window.location は使わない） */
  url: string;
}

export function ShareButton({ title, url }: ShareButtonProps) {
  const t = useTranslations('common.actions');
  // native share はクライアントでしか使えないため、mount 後のみ表示して hydration mismatch を防ぐ
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const encodedTitle = encodeURIComponent(title);
  const encodedUrl = encodeURIComponent(url);

  const shareLinks = [
    {
      name: 'Twitter',
      icon: Twitter,
      url: `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`,
    },
    {
      name: 'Facebook',
      icon: Facebook,
      url: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    },
    {
      name: 'LinkedIn',
      icon: Linkedin,
      url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
    },
  ];

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('urlCopied'));
    } catch {
      toast.error(t('urlCopyFailed'));
    }
  };

  const handleNativeShare = async () => {
    try {
      await navigator.share({ title, url });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      await handleCopyLink();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {shareLinks.map((social) => (
        <Button key={social.name} variant="ghost" icon className="size-8" asChild>
          <a
            href={social.url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('shareOn', { platform: social.name })}
            aria-label={t('shareOn', { platform: social.name })}
          >
            <social.icon className="size-4" />
          </a>
        </Button>
      ))}
      <Button
        variant="ghost"
        icon
        className="size-8"
        onClick={handleCopyLink}
        title={t('copyLink')}
        aria-label={t('copyLink')}
      >
        <Copy className="size-4" />
      </Button>
      {mounted && 'share' in navigator && (
        <Button
          variant="ghost"
          icon
          className="size-8"
          onClick={handleNativeShare}
          title={t('share')}
          aria-label={t('share')}
        >
          <Link2 className="size-4" />
        </Button>
      )}
    </div>
  );
}
