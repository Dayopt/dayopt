'use client';

import { TimeArtwork } from '@web/components/content/TimeArtwork';
import Image from 'next/image';
import { useState } from 'react';

interface BlogImageProps {
  src: string | undefined;
  alt: string;
  priority?: boolean;
  aspectRatio?: 'default' | 'square';
  sizes?: string;
  variant?: number;
}

/**
 * 画像エラーハンドリング付きのブログ画像コンポーネント
 * PostCardをServer Componentに保つため、クライアント側の状態管理をここに分離
 */
export function BlogImage({
  src,
  alt,
  priority = false,
  variant = 0,
  aspectRatio = 'default',
  sizes = '(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw',
}: BlogImageProps) {
  const [imageError, setImageError] = useState(false);

  const aspectClass = aspectRatio === 'square' ? 'aspect-square' : 'aspect-[380/214]';

  if (!src || imageError) {
    return (
      <div
        className={`bg-muted flex ${aspectClass} items-center justify-center transition-all duration-300`}
      >
        <TimeArtwork variant={variant} />
      </div>
    );
  }

  return (
    <div className={`relative ${aspectClass} overflow-hidden transition-all duration-300`}>
      <Image
        src={src}
        alt={alt}
        fill
        className="object-cover"
        onError={() => setImageError(true)}
        priority={priority}
        sizes={sizes}
      />
    </div>
  );
}
