#!/usr/bin/env node

/**
 * client bundle への secret 混入検査。
 *
 * `apps/product/.next/static` 配下の JS を走査し、secret を示すパターンが
 * 混入していないか調べる。1 件でも見つかれば exit 1。
 *
 * **build の中で走らせる**（`apps/product/vercel.json` の buildCommand）。
 * CI の placeholder env で走らせていた頃は、実 secret が build 環境に存在しない
 * ため「ハードコードされた literal」しか検出できなかった。Vercel の build は
 * 実 env を持つので、`sk_live_` / `whsec_` / `ghp_` のような値プレフィックスが
 * 実際に client へ漏れた場合も捕まえられる。
 *
 * 検出時に一致した行そのものは出力しない。build log へ secret を二次流出させない
 * ため、ファイル path と一致したパターン名だけを出す。
 *
 * Usage:
 *   node scripts/tasks/check-client-bundle-secrets.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATIC_DIR = resolve(ROOT, 'apps/product/.next/static');

/**
 * server 専用の env 名と、値そのもののプレフィックス。
 * env 名を含めるのは「client component が誤って参照した」形を検出するため。
 */
const PATTERNS = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'RECOVERY_CODE_PEPPER',
  'SENTRY_AUTH_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'RESEND_API_KEY',
  'RECAPTCHA_SECRET_KEY',
  'GITHUB_TOKEN',
  'sk_live_',
  'sk_test_',
  'whsec_',
  'ghp_',
];

function collectJsFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

function main() {
  const files = collectJsFiles(STATIC_DIR);

  // build 成果物が無いまま緑を返すと、検査したつもりで素通しになる。
  if (files.length === 0) {
    console.error(`Error: no client JS found under ${STATIC_DIR}. Run the build first.`);
    process.exit(1);
  }

  const hits = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    // supabase-js itself contains startsWith('sb_secret_'). Require key material
    // after the prefix, without exempting the SDK chunk from leak detection.
    if (/sb_secret_[A-Za-z0-9_-]+/u.test(content)) {
      hits.push({ file: relative(ROOT, file), pattern: 'Supabase secret key literal' });
    }
    for (const pattern of PATTERNS) {
      if (content.includes(pattern)) {
        hits.push({ file: relative(ROOT, file), pattern });
      }
    }
  }

  if (hits.length > 0) {
    console.error(`Secret pattern found in client bundle (${hits.length} hit(s)):`);
    for (const hit of hits) {
      // 一致した行は出さない。path と pattern 名だけで調査には足りる。
      console.error(`  ${hit.pattern}  ->  ${hit.file}`);
    }
    process.exit(1);
  }

  console.log(`No secrets found in client bundle (${files.length} files scanned)`);
}

main();
