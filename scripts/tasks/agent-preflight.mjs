import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * User 本人の OAuth token に付く classic scope のうち、Agent セッションに載っていては
 * いけないもの。fine-grained PAT は classic scope を持たないので、これが 1 つでも
 * 見えたら「User の gh identity をそのまま使っている」と判定できる（監査 P1-1）。
 */
export const BROAD_GH_SCOPES = ['admin:org', 'delete_repo', 'repo', 'workflow', 'admin:repo_hook'];

/**
 * `gh auth status` の人間可読出力から account と classic scope だけを抜く。
 * token 行（`- Token: gho_****`）は読まない（masked とはいえ state に載せる理由が無い）。
 * @param {string | null} text
 */
export function parseGhAuthStatus(text) {
  if (!text) return { account: null, scopes: [] };
  const account = text.match(/Logged in to github\.com account (\S+)/)?.[1] ?? null;
  const scopesLine = text.match(/Token scopes:\s*(.*)/)?.[1] ?? '';
  const scopes = [...scopesLine.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return { account, scopes };
}

/**
 * Agent セッションの gh identity。`GH_CONFIG_DIR` が agent 用 dir を指し、
 * classic の広い scope が見えなければ分離済み。gh 不在・未 login は null 扱い。
 * @param {{ env?: NodeJS.ProcessEnv, ghPresent?: boolean, statusText?: string | null }} [opts]
 */
export function collectGhIdentity({ env = process.env, ghPresent = true, statusText } = {}) {
  const configDir = env.GH_CONFIG_DIR ?? null;
  let text = statusText;
  if (text === undefined) {
    if (!ghPresent) text = null;
    else {
      try {
        // 未 login は exit 1 でも stderr に状態を出すので両方を読む
        text = execFileSync('gh', ['auth', 'status'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } catch (error) {
        text = [error?.stdout, error?.stderr].filter(Boolean).join('\n') || null;
      }
    }
  }
  const { account, scopes } = parseGhAuthStatus(text);
  const broadScopes = scopes.filter((scope) => BROAD_GH_SCOPES.includes(scope));
  return {
    configDir,
    account,
    scopes,
    broadScopes,
    isolated: broadScopes.length === 0 && account !== null,
  };
}

export function collectPreflight(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('Git worktree を確認できません');
  const hooksPath = git(['config', '--get', 'core.hooksPath'], root);
  const hooksRoot = hooksPath ? resolve(root, hooksPath) : null;
  const hooks = Object.fromEntries(
    ['pre-commit', 'pre-push'].map((name) => [
      name,
      Boolean(
        hooksRoot && existsSync(join(hooksRoot, name)) && existsSync(join(root, '.husky', name)),
      ),
    ]),
  );
  const cli = Object.fromEntries(
    ['gh', 'codex', 'op', 'supabase', 'gitleaks', 'vercel'].map((name) => {
      try {
        execFileSync('which', [name], { stdio: 'ignore' });
        return [name, true];
      } catch {
        return [name, false];
      }
    }),
  );
  const skills = existsSync(join(root, '.agents/skills/routing/SKILL.md'));
  const ghIdentity = collectGhIdentity({ ghPresent: cli.gh });
  return {
    cwd,
    root,
    branch: git(['branch', '--show-current'], root) || 'detached',
    changes: git(['status', '--short'], root),
    node: process.version,
    expectedNode: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
    dependencies: existsSync(join(root, 'node_modules/.pnpm')),
    hooksPath,
    hooks,
    cli,
    ghIdentity,
    skills,
    // Presence is not proof of runtime activation or trust.
    codexHooks: existsSync(join(root, '.codex/hooks.json'))
      ? 'configured; runtime activation unverified'
      : 'missing',
    readOnlyDelegation: {
      wrapper: false,
      codex: false,
      claude: false,
      native: 'unsupported; repository scope cannot be enforced at runtime',
    },
  };
}

function renderGhIdentity(identity) {
  if (!identity || identity.account === null) return '未 login / 未取得';
  const config = identity.configDir ? `config: ${identity.configDir}` : 'config: default';
  const scopes = identity.scopes.length ? identity.scopes.join(',') : 'none (fine-grained)';
  return `${identity.account} | ${config} | scopes: ${scopes}`;
}

export function renderPreflight(state) {
  const lines = [
    '## Project State',
    `**Root**: ${state.root}`,
    `**Cwd**: ${state.cwd}`,
    `**Branch**: ${state.branch}`,
    `**Changes**: ${state.changes === null ? '未取得' : state.changes || 'clean'}`,
    '### Environment',
    `**node**: ${state.node} (.nvmrc: ${state.expectedNode}) | **deps**: ${state.dependencies ? 'ok' : 'missing (pnpm install --frozen-lockfile)'}`,
    `**cli**: ${Object.entries(state.cli)
      .map(([name, present]) => `${name}:${present ? 'yes' : 'no'}`)
      .join(' ')}`,
    `**Git hooks**: ${Object.entries(state.hooks)
      .map(([name, active]) => `${name}:${active ? 'configured' : 'missing'}`)
      .join(' ')} (${state.hooksPath ?? '未設定'})`,
    `**Shared skills**: ${state.skills ? 'present; session discovery unverified' : 'missing'}`,
    `**Codex hooks**: ${state.codexHooks}`,
    `**Read-only delegation**: wrapper:${state.readOnlyDelegation?.wrapper ? 'yes' : 'no'} codex:${state.readOnlyDelegation?.codex ? 'yes' : 'no'} claude:${state.readOnlyDelegation?.claude ? 'yes' : 'no'}; native: ${state.readOnlyDelegation?.native ?? 'unverified'}`,
    `**gh identity**: ${renderGhIdentity(state.ghIdentity)}`,
  ];
  if (state.ghIdentity?.broadScopes.length)
    lines.push(
      `- gh が User の OAuth token（${state.ghIdentity.broadScopes.join(', ')}）で動いている。Agent セッションは GH_CONFIG_DIR を agent 用 fine-grained PAT へ切り替える（docs/operations/secrets.md §Agent の gh identity）`,
    );
  if (!state.cli.gh)
    lines.push(
      '- gh なし: ctx / trace / branch:finish の GitHub 情報は未取得。利用可能な接続で確認する',
    );
  if (!state.dependencies || Object.values(state.hooks).some((ready) => !ready)) {
    lines.push('- commit / push 前に依存と Git hooks を準備してください');
  }
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--json'))
      throw new Error('Usage: pnpm agent:preflight [--json]');
    const state = collectPreflight();
    console.log(args.includes('--json') ? JSON.stringify(state, null, 2) : renderPreflight(state));
    if (!state.dependencies || Object.values(state.hooks).some((ready) => !ready) || !state.skills)
      process.exitCode = 1;
  } catch (error) {
    console.error(`未取得: ${error.message}`);
    process.exitCode = 1;
  }
}
