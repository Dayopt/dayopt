import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'apps/product/package.json'));

it('Next build includes the actual broker route only in Preview artifacts', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'dayopt-broker-build-'));
  const app = join(fixture, 'apps/product');
  const route = 'src/app/api/preview-fixtures/route.preview.js';
  try {
    mkdirSync(join(app, 'src/app/api/preview-fixtures'), { recursive: true });
    symlinkSync(join(root, 'scripts'), join(fixture, 'scripts'), 'dir');
    symlinkSync(join(root, 'apps/product/node_modules'), join(app, 'node_modules'), 'dir');
    copyFileSync(join(root, 'apps/product', route), join(app, route));
    copyFileSync(
      join(root, 'apps/product/preview-route-extensions.mjs'),
      join(app, 'preview-route-extensions.mjs'),
    );
    writeFileSync(join(app, 'package.json'), '{"private":true,"type":"module"}');
    writeFileSync(
      join(app, 'src/app/layout.jsx'),
      'export default function Layout({children}) { return <html><body>{children}</body></html> }',
    );
    writeFileSync(
      join(app, 'src/app/page.jsx'),
      'export default function Page() { return <p>Fixture</p> }',
    );
    writeFileSync(
      join(app, 'next.config.mjs'),
      "import {productPageExtensions} from './preview-route-extensions.mjs'; export default {pageExtensions:productPageExtensions(),agentRules:false,experimental:{cpus:1}};",
    );
    for (const mode of ['preview', 'production']) {
      rmSync(join(app, '.next'), { recursive: true, force: true });
      execFileSync(
        process.execPath,
        [require.resolve('next/dist/bin/next'), 'build', '--webpack'],
        {
          cwd: app,
          timeout: 120_000,
          stdio: 'pipe',
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            VERCEL_ENV: mode,
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      );
      const manifest = JSON.parse(
        readFileSync(join(app, '.next/server/app-paths-manifest.json'), 'utf8'),
      );
      expect(Object.hasOwn(manifest, '/api/preview-fixtures/route')).toBe(mode === 'preview');
      expect(Object.keys(manifest).some((key) => key.includes('preview-fixtures'))).toBe(
        mode === 'preview',
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 250_000);
