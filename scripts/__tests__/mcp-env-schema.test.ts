import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { envSchema, productionEnvSchema, type EnvSchemaEntry } from '../tasks/env/schema';

const MCP_APP_ENV_NAMES = [
  'OAUTH_CLAUDE_REDIRECT_URIS',
  'OAUTH_CHATGPT_REDIRECT_URIS',
  'OAUTH_CURSOR_REDIRECT_URIS',
  'MCP_OAUTH_ENVIRONMENT',
  'OAUTH_AUTHORIZATION_SERVER_URI',
  'MCP_CANONICAL_RESOURCE_URI',
  'MCP_WRITE_ENABLED_CLIENTS',
] as const;

const MCP_PREVIEW_ENV_NAMES = [
  'MCP_OAUTH_PREVIEW_BRANCH',
  'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
] as const;

const opEnvExample = readFileSync(
  fileURLToPath(new URL('../../.op-env.agent.example', import.meta.url)),
  'utf8',
);

const setup1PasswordScript = readFileSync(
  fileURLToPath(new URL('../runbook/setup-1password.sh', import.meta.url)),
  'utf8',
);

const secretsDocumentation = readFileSync(
  fileURLToPath(new URL('../../docs/operations/secrets.md', import.meta.url)),
  'utf8',
);

function findExactEntry(schema: readonly EnvSchemaEntry[], envName: string): EnvSchemaEntry {
  const matches = schema.filter((entry) => entry.envName === envName);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('MCP OAuth env inventory', () => {
  it.each([
    {
      environment: 'staging' as const,
      schema: envSchema,
      vault: 'agent',
      pendingReason: undefined,
    },
    {
      environment: 'production' as const,
      schema: productionEnvSchema,
      vault: 'human',
      // production の MCP app 変数は #2553（#1754 epic の Production 有効化
      // ゲート）の未展開分として pendingReason を持つ（#2063）。#2553 の手順 1
      // で Vercel へ投入され、pending が解消される。staging は local dev
      // 直接消費のため schema先行ではなく pendingReason を付けない。
      pendingReason: '#2553（#1754 epic の Production 有効化ゲート）の production 未展開分',
    },
  ])(
    '$environmentのapp itemにclient redirect、OAuth identity、MCP gateをexactly once登録する',
    ({ environment, schema, vault, pendingReason }) => {
      for (const envName of MCP_APP_ENV_NAMES) {
        expect(findExactEntry(schema, envName)).toEqual({
          envName,
          // dark release では 1Password field 未作成の開発者の `pnpm env:check` を
          // 落とさないため、MCP 変数はすべて optional に保つ。
          required: false,
          visibility: 'public',
          environment,
          vault,
          item: 'app',
          field: envName,
          ...(pendingReason ? { pendingReason } : {}),
        });
      }
    },
  );

  it('local 1Password referenceにMCP app変数をexactly once置く', () => {
    for (const envName of [...MCP_APP_ENV_NAMES, ...MCP_PREVIEW_ENV_NAMES]) {
      const matches = opEnvExample.match(
        new RegExp(`^${envName}=op://agent/app/${envName}$`, 'gmu'),
      );
      expect(matches, envName).toHaveLength(1);
    }
  });

  // .env.example（app ごとの変数名一覧）は 2026-08-14 に廃止（#2086 の env
  // ファイル境界再編。schema.ts と重複する手動維持コピーで drift 源だった）。
  // 対応する inventory 検査もここから外した。

  it('Preview専用変数をStagingのapp itemだけに登録する', () => {
    for (const envName of MCP_PREVIEW_ENV_NAMES) {
      expect(findExactEntry(envSchema, envName)).toEqual({
        envName,
        required: false,
        visibility: 'public',
        environment: 'staging',
        vault: 'agent',
        item: 'app',
        field: envName,
      });
      expect(productionEnvSchema.some((entry) => entry.envName === envName)).toBe(false);
      expect(setup1PasswordScript.match(new RegExp(`'${envName}\\[text\\]='`, 'gu'))).toHaveLength(
        1,
      );
    }
  });

  it('1Password setupとSecrets文書のapp itemにMCP変数を載せる', () => {
    const appRows = secretsDocumentation.split('\n').filter((line) => line.startsWith('| `app`'));
    expect(appRows).toHaveLength(2);

    for (const envName of MCP_APP_ENV_NAMES) {
      const setupMatches = setup1PasswordScript.match(new RegExp(`'${envName}\\[text\\]='`, 'gu'));
      expect(setupMatches, envName).toHaveLength(2);
      for (const row of appRows) expect(row).toContain(envName);
    }
  });

  it('常設Stagingを前提にしないことをSecrets文書で宣言する', () => {
    expect(secretsDocumentation).toContain('常設Stagingは作らない');
  });
});
