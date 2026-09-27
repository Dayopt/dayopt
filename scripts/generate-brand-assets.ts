/** Figma approved F -> public assets. Run: pnpm exec tsx scripts/generate-brand-assets.ts */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DAYOPT_BRAND as brand } from '../packages/components/src/identity/logo-data';

async function main() {
  const root = process.cwd();
  const source = path.join(root, 'assets/brand');
  const paths = (items: readonly string[], color: string) =>
    items
      .map(
        (d, i) =>
          `<path id="${items.length === 1 ? 'Wordmark-outlined' : i === 0 ? 'Plan-outline' : i === 1 ? 'Log-solid' : 'Wordmark-outlined'}" fill="${color}" fill-rule="${items.length > 1 && i === 0 ? 'evenodd' : 'nonzero'}" d="${d}"/>`,
      )
      .join('');
  const svg = (box: string, content: string, width: number, height: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box}">${content}</svg>\n`;
  const appIcon = ({ rounded = false, maskable = false } = {}) => {
    // The symbol occupies 75% of a regular icon; the maskable version stays inside the safe area.
    const scale = (1024 * (maskable ? 0.6 : 0.75)) / 99;
    const x = 512 - 10.24 - 50 * scale;
    const y = 512 - 50 * scale;
    return svg(
      '0 0 1024 1024',
      `<rect width="1024" height="1024" rx="${rounded ? 256 : 0}" fill="${brand.reverse}"/><g transform="translate(${x} ${y}) scale(${scale})">${paths(brand.symbol, brand.primary)}</g>`,
      1024,
      1024,
    );
  };
  const ogImage = (background: string, foreground: string) =>
    svg(
      '0 0 1200 630',
      `<rect width="1200" height="630" fill="${background}"/><g transform="translate(288.8 249.4) scale(1.6) translate(0 -22)">${paths(brand.lockup, foreground)}</g>`,
      1200,
      630,
    );
  const assets: Record<string, string> = {};
  for (const [name, color] of [
    ['primary', brand.primary],
    ['reverse', brand.reverse],
  ]) {
    assets[`dayopt-lockup-${name}.svg`] = svg('0 22 389 82', paths(brand.lockup, color), 389, 82);
    assets[`dayopt-wordmark-${name}.svg`] = svg(
      '105.753 22 279.131 82',
      paths([brand.lockup[2]], color),
      279.131,
      82,
    );
    assets[`dayopt-symbol-${name}.svg`] = svg('0 0 100 100', paths(brand.symbol, color), 100, 100);
    assets[`dayopt-symbol-tight-${name}.svg`] = svg(
      '0.5 5 99 90',
      paths(brand.symbol, color),
      99,
      90,
    );
  }
  // Short, descriptive names are the default primary assets for light backgrounds.
  assets['mark.svg'] = assets['dayopt-symbol-primary.svg'];
  assets['wordmark.svg'] = assets['dayopt-wordmark-primary.svg'];
  assets['lockup.svg'] = assets['dayopt-lockup-primary.svg'];
  assets['dayopt-app-icon.svg'] = appIcon();
  assets['dayopt-app-icon-maskable.svg'] = appIcon({ maskable: true });
  assets['dayopt-app-icon-rounded-preview.svg'] = appIcon({ rounded: true });
  assets['favicon.svg'] = appIcon({ rounded: true });
  assets['og-image-light.svg'] = ogImage(brand.reverse, brand.primary);
  assets['og-image-dark.svg'] = ogImage(brand.primary, brand.reverse);
  const ogPngs = {
    light: await sharp(Buffer.from(assets['og-image-light.svg'])).png().toBuffer(),
    dark: await sharp(Buffer.from(assets['og-image-dark.svg'])).png().toBuffer(),
  };
  await mkdir(source, { recursive: true });
  for (const [name, data] of Object.entries(assets)) await writeFile(path.join(source, name), data);
  for (const app of ['product', 'web']) {
    const pub = path.join(root, `apps/${app}/public`);
    const dest = path.join(pub, 'brand');
    const appMetadataDir = app === 'web' ? path.join(root, 'apps/web/src/app') : undefined;
    await mkdir(dest, { recursive: true });
    await mkdir(path.join(pub, 'icons'), { recursive: true });
    if (appMetadataDir) await mkdir(appMetadataDir, { recursive: true });
    for (const [name, data] of Object.entries(assets)) await writeFile(path.join(dest, name), data);
    await copyFile(path.join(source, 'Inter-LICENSE.txt'), path.join(dest, 'Inter-LICENSE.txt'));
    for (const name of ['lockup', 'wordmark', 'symbol'])
      for (const tone of ['primary', 'reverse']) {
        await sharp(Buffer.from(assets[`dayopt-${name}-${tone}.svg`]))
          .resize({ width: name === 'symbol' ? 1024 : 1600 })
          .png()
          .toFile(path.join(dest, `dayopt-${name}-${tone}.png`));
      }
    for (const n of [192, 512, 1024])
      await sharp(Buffer.from(appIcon()))
        .resize(n, n)
        .png()
        .toFile(path.join(dest, `dayopt-app-icon-${n}.png`));
    for (const [theme, png] of Object.entries(ogPngs)) {
      const name = `og-image-${theme}.png`;
      await writeFile(path.join(pub, name), png);
      await writeFile(path.join(dest, name), png);
    }
    // Keep the existing URL working; its established appearance is the dark variant.
    await writeFile(path.join(pub, 'og-image.png'), ogPngs.dark);
    await writeFile(path.join(dest, 'og-image.png'), ogPngs.dark);
    const faviconFiles: Record<string, Buffer> = {};
    const pngs: Buffer[] = [];
    for (const n of [16, 32, 48]) {
      const b = await sharp(Buffer.from(appIcon({ rounded: true })))
        .resize(n, n)
        .png()
        .toBuffer();
      pngs.push(b);
      const name = `favicon-${n}x${n}.png`;
      faviconFiles[name] = b;
      if (!appMetadataDir) await writeFile(path.join(pub, name), b);
    }
    const header = Buffer.alloc(6 + pngs.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach((b, i) => {
      const p = 6 + i * 16;
      header[p] = [16, 32, 48][i];
      header[p + 1] = header[p];
      header.writeUInt16LE(1, p + 4);
      header.writeUInt16LE(32, p + 6);
      header.writeUInt32LE(b.length, p + 8);
      header.writeUInt32LE(offset, p + 12);
      offset += b.length;
    });
    const faviconIco = Buffer.concat([header, ...pngs]);
    faviconFiles['favicon.ico'] = faviconIco;
    if (appMetadataDir) {
      await writeFile(path.join(appMetadataDir, 'favicon.ico'), faviconIco);
      await writeFile(path.join(appMetadataDir, 'icon.svg'), assets['favicon.svg']);
    } else {
      await writeFile(path.join(pub, 'favicon.svg'), assets['favicon.svg']);
      await writeFile(path.join(pub, 'favicon.ico'), faviconIco);
    }
    for (const n of [192, 512]) {
      const square = await sharp(Buffer.from(appIcon({ maskable: true })))
        .resize(n, n)
        .png()
        .toBuffer();
      const rounded = await sharp(Buffer.from(appIcon({ rounded: true })))
        .resize(n, n)
        .png()
        .toBuffer();
      if (n === 192 || n === 512) {
        await writeFile(path.join(pub, `icons/icon-${n}.png`), rounded);
        await writeFile(path.join(pub, `icons/icon-${n}-maskable.png`), square);
        await writeFile(path.join(dest, `dayopt-app-icon-maskable-${n}.png`), square);
      }
    }
    const apple = await sharp(Buffer.from(appIcon())).resize(180, 180).png().toBuffer();
    faviconFiles['apple-touch-icon.png'] = apple;
    if (appMetadataDir) {
      await writeFile(path.join(appMetadataDir, 'apple-icon.png'), apple);
      for (const name of [
        'favicon.svg',
        'favicon.ico',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'favicon-48x48.png',
        'apple-touch-icon.png',
      ]) {
        await rm(path.join(pub, name), { force: true });
      }
    } else {
      await writeFile(path.join(pub, 'apple-touch-icon.png'), apple);
    }
    await writeFile(path.join(pub, 'icons/apple-touch-icon.png'), apple);
    await sharp(Buffer.from(appIcon())).resize(512, 512).png().toFile(path.join(pub, 'logo.png'));
    for (const [name, data] of Object.entries(faviconFiles)) {
      await writeFile(path.join(dest, name), data);
    }
    const og = svg(
      '0 0 1200 630',
      `<rect width="1200" height="630" fill="${brand.primary}"/><g transform="translate(288.8 249.4) scale(1.6) translate(0 -22)">${paths(brand.lockup, brand.reverse)}</g>`,
      1200,
      630,
    );
    await sharp(Buffer.from(og)).png().toFile(path.join(pub, 'og-image.png'));
  }
  for (const [src, dst] of [
    ['icons/icon-192.png', 'icon-192.png'],
    ['icons/icon-512.png', 'icon-512.png'],
    ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ]) {
    await copyFile(
      path.join(root, 'apps/product/public', src),
      path.join(root, 'apps/product/assets/pwa-icons', dst),
    );
  }
  // zip is available on macOS/Linux; no extra JavaScript dependency required.
  for (const app of ['product', 'web']) {
    const dest = path.join(root, `apps/${app}/public/brand`);
    await copyFile(path.join(root, 'docs/business/brand.md'), path.join(dest, 'README.md'));
    for (const name of ['og-image.png', 'og-image-light.png', 'og-image-dark.png']) {
      await copyFile(path.join(root, `apps/${app}/public`, name), path.join(dest, name));
    }
    const files = (await readdir(dest)).filter((name) => !name.endsWith('.zip')).sort();
    await rm(path.join(dest, 'dayopt-brand-F.zip'), { force: true });
    execFileSync('zip', ['-X', '-q', 'dayopt-brand-F.zip', ...files], { cwd: dest });
  }
  console.log(
    'Generated approved F SVG, PNG, ICO, PWA and light/dark OG assets for product and web.',
  );
}
void main();
