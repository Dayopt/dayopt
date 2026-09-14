import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ciSecretSchema } from '../tasks/env/schema';

// GitHub Actions Secrets は 1Password `ci` vault の replica（docs/operations/secrets.md
// §Replica 台帳）。基本方針 7「値がどこにあっても 1Password にもある」を、名前の対応で
// 機械検査する。GitHub の Secret 一覧 API は admin 権限が要り CI からも agent からも
// 読めないため、workflow が参照する名前を「実在する replica」の代理として使う。
//
// 保証境界: workflow が参照する名前と台帳の対応だけを見る。値の一致、どの workflow にも
// 参照されない GitHub Secret（orphan）の存在、environment 単位の Secret は見ない。
const rootDir = resolve(import.meta.dirname, '../..');
const workflowDir = join(rootDir, '.github/workflows');
// GitHub が run ごとに自動発行する token。replica ではない
const PLATFORM_SECRETS = new Set(['GITHUB_TOKEN']);

function referencedSecrets(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(workflowDir, file), 'utf8');
    // 式 `${{ ... secrets.NAME ... }}` の中だけを見る（コメント中の docs/operations/secrets.md 等を拾わない）
    for (const match of text.matchAll(/\$\{\{[^}]*?\bsecrets\.([A-Z0-9_]+)/g)) {
      const name = match[1];
      if (PLATFORM_SECRETS.has(name)) continue;
      refs.set(name, [...new Set([...(refs.get(name) ?? []), file])]);
    }
  }
  return refs;
}

const ledgerNames = new Map(
  ciSecretSchema.map((entry) => [entry.githubSecret ?? entry.envName, entry]),
);

describe('CI secret ledger（workflow の secrets.* ⇔ 1Password ci vault）', () => {
  it('workflow が参照する GitHub Secret はすべて ci 台帳に master を持つ', () => {
    const missing = [...referencedSecrets()]
      .filter(([name]) => !ledgerNames.has(name))
      .map(([name, files]) => `${name}（${files.join(', ')}）`);
    expect(missing, '台帳に無い Secret を足すか、workflow から参照を外す').toEqual([]);
  });

  it('ci 台帳の entry はすべてどこかの workflow が参照している（使われない master を残さない）', () => {
    const refs = referencedSecrets();
    const unused = [...ledgerNames.keys()].filter((name) => !refs.has(name));
    expect(unused).toEqual([]);
  });

  it('ci 台帳は ci vault だけを指し、Secret 名は重複しない', () => {
    expect(ciSecretSchema.every((entry) => entry.vault === 'ci')).toBe(true);
    expect(ledgerNames.size).toBe(ciSecretSchema.length);
  });

  it('台帳に無い名前を workflow が参照すると検出できる（検査が空振りしていない）', () => {
    const refs = referencedSecrets();
    expect(refs.size).toBeGreaterThan(0);
    expect(ledgerNames.has('DAYOPT_UNREGISTERED_SECRET')).toBe(false);
    // 既知の参照が 1 件でも台帳から外れたら落ちることを、実データで確かめる
    const [first] = [...refs.keys()];
    const withoutFirst = new Set([...ledgerNames.keys()].filter((name) => name !== first));
    expect([...refs.keys()].filter((name) => !withoutFirst.has(name))).toEqual([first]);
  });
});
