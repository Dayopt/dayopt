#!/usr/bin/env node

/**
 * i18n整合性チェッカー
 *
 * 翻訳ファイルの構造的な整合性を3つの観点で検証する:
 *
 * 1. 1ファイル=1トップレベルキー規約
 *    → JSONファイル名と一致するトップレベルキーのみ許可（例外あり）
 *
 * 2. EN/JAキーパリティ
 *    → 両ロケール間でキー構造が完全一致するか検証
 *
 * 3. pickMessages配信チェック
 *    → クライアントコンポーネントが使うnamespaceがルートグループで配信されるか検証
 *
 * Usage:
 *   npx tsx scripts/tasks/check-i18n-integrity.ts
 */

import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const APP_ROOT = resolve(ROOT, 'apps/product');
const MESSAGES_DIR = resolve(APP_ROOT, 'messages');
const SRC_DIR = resolve(APP_ROOT, 'src');

const LOCALES = ['en', 'ja'] as const;

// ファイル名とトップキーが一致しない歴史的例外
const MULTI_KEY_EXCEPTIONS: Record<string, string[]> = {
  common: ['app', 'common'],
  email: [
    'emailCommon',
    'welcome',
    'passwordChanged',
    'mfaDisabled',
    'accountDeletion',
    'trialStart',
    // trialExpiring / trialExpired は撤去した。トライアルの催促メールは送らない方針
    // （docs/product/specs/billing.md「終了7日前からアプリ内案内を出す。新しい催促メールは送らない」）
    'proStart',
    'paymentFailed',
    'paymentRecovered',
    'cancellationConfirm',
  ],
};

interface Violation {
  rule: string;
  file: string;
  message: string;
}

const violations: Violation[] = [];

// ─── Utility ───

function getAllKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getAllKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function loadJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

// ─── Check 1: 1ファイル=1トップレベルキー規約 ───

function checkOneFileOneKey(): void {
  for (const locale of LOCALES) {
    const dir = join(MESSAGES_DIR, locale);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const name = file.replace('.json', '');
      const data = loadJson(join(dir, file));
      const topKeys = Object.keys(data);

      const expected = MULTI_KEY_EXCEPTIONS[name] ?? [name];

      // 期待されないキーがあるか
      const unexpected = topKeys.filter((k) => !expected.includes(k));
      if (unexpected.length > 0) {
        violations.push({
          rule: 'one-file-one-key',
          file: `messages/${locale}/${file}`,
          message: `Unexpected top-level keys: [${unexpected.join(', ')}]. Expected: [${expected.join(', ')}]`,
        });
      }

      // 期待されるキーが欠けているか
      const missing = expected.filter((k) => !topKeys.includes(k));
      if (missing.length > 0) {
        violations.push({
          rule: 'one-file-one-key',
          file: `messages/${locale}/${file}`,
          message: `Missing expected top-level keys: [${missing.join(', ')}]`,
        });
      }
    }
  }
}

// ─── Check 2: EN/JAキーパリティ ───

function checkKeyParity(): void {
  const baseLocale = LOCALES[0]; // en
  const baseDir = join(MESSAGES_DIR, baseLocale);
  const baseFiles = readdirSync(baseDir).filter((f) => f.endsWith('.json'));

  for (const otherLocale of LOCALES.slice(1)) {
    const otherDir = join(MESSAGES_DIR, otherLocale);
    const otherFiles = readdirSync(otherDir).filter((f) => f.endsWith('.json'));

    // ファイル存在チェック
    for (const file of baseFiles) {
      if (!otherFiles.includes(file)) {
        violations.push({
          rule: 'key-parity',
          file: `messages/${otherLocale}/`,
          message: `Missing file: ${file} (exists in ${baseLocale})`,
        });
      }
    }
    for (const file of otherFiles) {
      if (!baseFiles.includes(file)) {
        violations.push({
          rule: 'key-parity',
          file: `messages/${otherLocale}/${file}`,
          message: `Extra file: ${file} (not in ${baseLocale})`,
        });
      }
    }

    // キー構造チェック
    const commonFiles = baseFiles.filter((f) => otherFiles.includes(f));
    for (const file of commonFiles) {
      const baseData = loadJson(join(baseDir, file));
      const otherData = loadJson(join(otherDir, file));

      const baseKeys = new Set(getAllKeys(baseData));
      const otherKeys = new Set(getAllKeys(otherData));

      for (const key of baseKeys) {
        if (!otherKeys.has(key)) {
          violations.push({
            rule: 'key-parity',
            file: `messages/${otherLocale}/${file}`,
            message: `Missing key: "${key}" (exists in ${baseLocale})`,
          });
        }
      }
      for (const key of otherKeys) {
        if (!baseKeys.has(key)) {
          violations.push({
            rule: 'key-parity',
            file: `messages/${otherLocale}/${file}`,
            message: `Extra key: "${key}" (not in ${baseLocale})`,
          });
        }
      }
    }
  }
}

// ─── Check 3: pickMessages配信チェック ───

interface RouteGroup {
  name: string;
  layoutPath: string;
  namespaces: string[];
  /** このルートグループ配下のディレクトリパス（src/app/[locale]/(group)/以下） */
  scopeDir: string;
}

function discoverRouteGroups(): RouteGroup[] {
  // レイアウトファイルからNAMESPACES定数を抽出
  const layoutPattern = 'src/app/[locale]';
  const groups: RouteGroup[] = [];

  const groupDirs = ['(app)', '(auth)'];
  for (const groupDir of groupDirs) {
    const layoutPath = join(SRC_DIR, 'app/[locale]', groupDir, 'layout.tsx');
    try {
      const content = readFileSync(layoutPath, 'utf-8');
      // const XXX_NAMESPACES = ['common', 'auth', 'error'];
      const match = content.match(/(?:const\s+\w+_NAMESPACES|namespaces)\s*=\s*\[([^\]]+)\]/);
      if (match) {
        const namespaces = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        groups.push({
          name: groupDir,
          layoutPath: `${layoutPattern}/${groupDir}/layout.tsx`,
          namespaces,
          scopeDir: join(SRC_DIR, 'app/[locale]', groupDir),
        });
      }
    } catch {
      // layout.tsxが存在しない場合はスキップ
    }
  }

  return groups;
}

/**
 * 指定ディレクトリ配下の全 .ts/.tsx ファイルから
 * useTranslations('namespace') のnamespace引数を抽出
 */
function findClientNamespacesInDir(dir: string): Map<string, string[]> {
  // namespace → file[] のマップ
  const nsToFiles = new Map<string, string[]>();

  try {
    // rgを使ってuseTranslationsの呼び出しを検索
    const result = execSync(
      `grep -r "useTranslations(" "${dir}" --include="*.ts" --include="*.tsx" -l 2>/dev/null || true`,
      { encoding: 'utf-8' },
    );

    const files = result.split('\n').filter((f) => f.trim().length > 0);

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf-8');

      // 'use client' のファイルのみ対象
      if (!content.includes("'use client'") && !content.includes('"use client"')) {
        continue;
      }

      // useTranslations('namespace.sub') → 'namespace' 部分を抽出
      const matches = [...content.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)];
      for (const m of matches) {
        const fullNs = m[1];
        // トップレベルnamespace（pickMessagesはトップレベルで動作）
        const topNs = fullNs.split('.')[0];
        const existing = nsToFiles.get(topNs) ?? [];
        const relative = filePath.replace(ROOT + '/', '');
        existing.push(relative);
        nsToFiles.set(topNs, existing);
      }
    }
  } catch {
    // grepがマッチなしで終了した場合
  }

  return nsToFiles;
}

/**
 * ルートグループ外の共有コンポーネントから使われるnamespaceも検出
 * （shell/, components/, features/ 等）
 * これらはどのルートグループから呼ばれるか静的には判定できないため、
 * 全ルートグループで配信されているかチェックする
 */
function findSharedClientNamespaces(): Map<string, string[]> {
  const sharedDirs = [
    join(SRC_DIR, 'shell'),
    join(SRC_DIR, 'components'),
    join(SRC_DIR, 'features'),
    join(SRC_DIR, 'core'),
  ];

  const nsToFiles = new Map<string, string[]>();
  for (const dir of sharedDirs) {
    const dirNs = findClientNamespacesInDir(dir);
    for (const [ns, files] of dirNs) {
      const existing = nsToFiles.get(ns) ?? [];
      existing.push(...files);
      nsToFiles.set(ns, existing);
    }
  }

  return nsToFiles;
}

function checkPickMessagesDelivery(): void {
  const groups = discoverRouteGroups();

  if (groups.length === 0) {
    violations.push({
      rule: 'pick-messages',
      file: 'src/app/[locale]/',
      message: 'No route groups with IntlProvider namespaces found',
    });
    return;
  }

  // 各JSONファイルのトップレベルキー→namespace のマッピング
  const enDir = join(MESSAGES_DIR, 'en');
  const availableNamespaces = new Set<string>();
  for (const file of readdirSync(enDir).filter((f) => f.endsWith('.json'))) {
    const data = loadJson(join(enDir, file));
    for (const key of Object.keys(data)) {
      availableNamespaces.add(key);
    }
  }

  // 各ルートグループ配下のクライアントコンポーネントをチェック
  for (const group of groups) {
    const nsUsed = findClientNamespacesInDir(group.scopeDir);

    for (const [ns, files] of nsUsed) {
      if (!group.namespaces.includes(ns) && availableNamespaces.has(ns)) {
        violations.push({
          rule: 'pick-messages',
          file: group.layoutPath,
          message: `Namespace "${ns}" used in client components [${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}] but not in pickMessages namespaces: [${group.namespaces.join(', ')}]`,
        });
      }
    }
  }

  // 共有コンポーネントのnamespaceが(app)グループで配信されているかチェック
  // (app)が最も広いスコープで、共有コンポーネントは主にここから使われる
  const appGroup = groups.find((g) => g.name === '(app)');
  if (appGroup) {
    const sharedNs = findSharedClientNamespaces();
    for (const [ns, files] of sharedNs) {
      if (!appGroup.namespaces.includes(ns) && availableNamespaces.has(ns)) {
        violations.push({
          rule: 'pick-messages',
          file: appGroup.layoutPath,
          message: `Shared namespace "${ns}" used in client components [${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}] but not delivered by (app) layout`,
        });
      }
    }
  }
}

// ─── Main ───

function main(): void {
  // eslint-disable-next-line no-console
  console.log('🔍 i18n integrity check...\n');

  checkOneFileOneKey();
  checkKeyParity();
  checkPickMessagesDelivery();

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log('✅ All checks passed.\n');
    process.exit(0);
  }

  // ルール別にグループ化して表示
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const existing = byRule.get(v.rule) ?? [];
    existing.push(v);
    byRule.set(v.rule, existing);
  }

  for (const [rule, items] of byRule) {
    // eslint-disable-next-line no-console
    console.error(`\n❌ [${rule}] ${items.length} violation(s):`);
    for (const item of items) {
      // eslint-disable-next-line no-console
      console.error(`  ${item.file}: ${item.message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.error(`\nTotal: ${violations.length} violation(s)`);
  process.exit(1);
}

main();
