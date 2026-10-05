import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveOgCardOptions, resolveOgScreenshotFilename } from '@dayopt/assets/og';
import { loadOgScreenshotDataUri } from '@dayopt/assets/og-screenshot';

describe('OG card options', () => {
  it.each([
    ['docs', 'center'],
    ['journal', 'left'],
    ['release', 'left'],
    ['product', 'left'],
  ] as const)('%s は標準レイアウトを解決する', (category, layout) => {
    expect(resolveOgCardOptions({ category })).toMatchObject({ category, layout });
  });

  it('Product は利用可能なスクリーンショットがある時だけ screenshot を既定にする', () => {
    expect(resolveOgCardOptions({ category: 'product', screenshotAvailable: true })).toMatchObject({
      category: 'product',
      layout: 'screenshot',
    });
  });

  it('明示した layout が category の既定値を上書きする', () => {
    expect(resolveOgCardOptions({ category: 'docs', layout: 'left' })).toMatchObject({
      category: 'docs',
      layout: 'left',
    });
  });

  it('screenshot layout は画像が無い場合 left に戻る', () => {
    expect(resolveOgCardOptions({ category: 'docs', layout: 'screenshot' })).toMatchObject({
      category: 'docs',
      layout: 'left',
    });
  });

  it('旧 type query を受け付け、不明な type/category は Product に戻す', () => {
    expect(resolveOgCardOptions({ legacyType: 'blog' })).toMatchObject({ category: 'journal' });
    expect(resolveOgCardOptions({ legacyType: 'docs' })).toMatchObject({ category: 'docs' });
    expect(resolveOgCardOptions({ legacyType: 'release' })).toMatchObject({ category: 'release' });
    expect(resolveOgCardOptions({ legacyType: 'malicious', category: 'unknown' })).toMatchObject({
      category: 'product',
    });
  });
});

describe('OG screenshot assets', () => {
  it('アプリ内 og-screenshots の PNG/JPEG/WebP basename だけを受け付ける', () => {
    expect(resolveOgScreenshotFilename('/og-screenshots/home.png')).toBe('home.png');
    expect(resolveOgScreenshotFilename('og-screenshots/mobile.webp')).toBe('mobile.webp');
    expect(resolveOgScreenshotFilename('og-screenshots/photo.jpeg')).toBe('photo.jpeg');
    expect(resolveOgScreenshotFilename('/og-screenshots/nested/image.png')).toBe(
      'nested/image.png',
    );
  });

  it.each([
    'https://example.com/image.png',
    '//example.com/image.png',
    '/og-screenshots/../secret.png',
    '/og-screenshots/image.svg',
    'image.png',
  ])('不正な screenshot path を拒否する: %s', (screenshot) => {
    expect(resolveOgScreenshotFilename(screenshot)).toBeNull();
  });

  it('存在する app-local screenshot を data URI にし、無い場合は空にする', async () => {
    const publicDirectory = await mkdtemp(path.join(os.tmpdir(), 'dayopt-og-'));
    const screenshotDirectory = path.join(publicDirectory, 'og-screenshots');
    await mkdir(screenshotDirectory);

    try {
      const pixelPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/EioAAAAASUVORK5CYII=',
        'base64',
      );
      await writeFile(path.join(screenshotDirectory, 'preview.png'), pixelPng);

      await expect(
        loadOgScreenshotDataUri('/og-screenshots/preview.png', publicDirectory),
      ).resolves.toBe(`data:image/png;base64,${pixelPng.toString('base64')}`);
      await expect(
        loadOgScreenshotDataUri('/og-screenshots/missing.png', publicDirectory),
      ).resolves.toBeUndefined();
      await expect(
        loadOgScreenshotDataUri('https://example.com/preview.png', publicDirectory),
      ).resolves.toBeUndefined();
    } finally {
      await rm(publicDirectory, { recursive: true, force: true });
    }
  });
});
