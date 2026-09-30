import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectLearnData, listLearnRefs } from '../learn/data.ts';
import { createDocumentationServer } from './doc-server.ts';

let root: string;
let server: ReturnType<typeof createDocumentationServer>;
let url: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-doc-server-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const repo = resolve(import.meta.dirname, '../../..');
  cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"check":"old-command"}}');
  writeFileSync(
    join(root, 'notes.md'),
    '<!-- docs-live:commands:start -->\n\n古い本文\n\n<!-- docs-live:commands:end -->\n',
  );
  server = createDocumentationServer(root);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}`;
});

it('起動中に TypeScript の用語正本を変更しても、次の閲覧で最新の定義を読む', async () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(root, 'docs/product'), { recursive: true });
  copyFileSync(join(repo, 'docs/product/glossary.md'), join(root, 'docs/product/glossary.md'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'scripts/tasks/serve-docs.ts'), '--no-open'],
    { cwd: root },
  );
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`viewer exited: ${code}`)));
    });
    const endpoint = address + '/doc?path=docs%2Fproduct%2Fglossary.md';
    expect(await (await fetch(endpoint)).text()).toContain('タイムブロック');
    const source = join(root, 'scripts/lib/glossary/terms.ts');
    writeFileSync(
      source,
      readFileSync(source, 'utf8').replace("ja: 'タイムブロック',", "ja: '最新タイムブロック',"),
    );
    const refreshed = await fetch(endpoint);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).toContain('最新タイムブロック');
  } finally {
    child.kill();
  }
}, 20000);
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

it('同じ閲覧サーバーへの次の HTTP request で正本の変更を反映し、破損時に古い本文を返さない', async () => {
  expect(await (await fetch(url + '/doc?path=notes.md')).text()).toContain('old-command');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"new-command"}}');
  const response = await fetch(url + '/doc?path=notes.md');
  const html = await response.text();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(html).toContain('<table>');
  expect(html).toContain('new-command');
  expect(html).not.toContain('old-command');
  expect(html).not.toContain('古い本文');
  writeFileSync(join(root, 'package.json'), '{');
  const broken = await fetch(url + '/doc?path=notes.md');
  expect(broken.status).toBe(500);
  expect(await broken.text()).not.toContain('new-command');
});

it('一覧を次の request で再発見し、文書外や正本の秘密ファイルを配信しない', async () => {
  expect(await (await fetch(url)).text()).not.toContain('new.md');
  writeFileSync(join(root, 'new.md'), '# New');
  expect(await (await fetch(url)).text()).toContain('new.md');
  writeFileSync(join(root, 'private.txt'), 'SECRET=value');
  expect((await fetch(url + '/doc?path=private.txt')).status).toBe(404);
  expect((await fetch(url + '/doc?path=../README.md')).status).toBe(404);
  expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  const status = await new Promise<number | undefined>((resolve) => {
    const req = request(url, { headers: { host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.end();
  });
  expect(status).toBe(403);
});

it('raw HTML・JSX・危険なリンクを実行せず、文書の内部リンクだけを登録 path に解決する', async () => {
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/next.md'), '# Next');
  writeFileSync(
    join(root, 'new.md'),
    '<script>alert(1)</script>\n\n<X />\n\n[bad](javascript:alert) [Next](docs/next.md) ![picture](https://attacker.example/pixel)',
  );
  const response = await fetch(url + '/doc?path=new.md');
  const html = await response.text();
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
  expect(html).toContain('/doc?path=docs%2Fnext.md');
  expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
});

it('教材の JSON 変更を同じサーバーの再読込に反映し、参照先消失では古い教材を表示しない', async () => {
  const repo = resolve(import.meta.dirname, '../../..');
  for (const path of ['docs/learn', 'apps/product/src/app/api'])
    cpSync(join(repo, path), join(root, path), { recursive: true });
  const references = listLearnRefs(collectLearnData(repo));
  for (const path of [
    'apps/product/vercel.json',
    'scripts/lib/learn/ui/template.html',
    ...references.map((entry) => entry.ref.path),
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  const source = join(root, 'docs/learn/system/services.md');
  const text = readFileSync(source, 'utf8');
  writeFileSync(source, text.replace(/("intro":\s*")[^"]*"/, '$1LEARN_REFRESH_TEST"'));
  const response = await fetch(url + '/learn');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('LEARN_REFRESH_TEST');
  expect(response.headers.get('content-security-policy')).toContain("'sha256-");
  writeFileSync(source, text.replace(/("intro":\s*")[^"]*"/, '$1LEARN_SECOND_TEST"'));
  const refreshed = await (await fetch(url + '/learn')).text();
  expect(refreshed).toContain('LEARN_SECOND_TEST');
  expect(refreshed).not.toContain('LEARN_REFRESH_TEST');
  rmSync(join(root, references[0].ref.path));
  const broken = await fetch(url + '/learn');
  expect(broken.status).toBe(500);
  expect(await broken.text()).not.toContain('LEARN_SECOND_TEST');
});
