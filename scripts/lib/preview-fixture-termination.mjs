import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

import { validateCloudIntent } from '../ci/preview-cloud-intent.mjs';
import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

const ERROR = 'Preview fixture database termination is unconfirmed';

/**
 * Trusted recovery caller only, after authenticating the source run/intent.
 * No CLI/HTTP entrypoint; the provider token never reaches candidate code.
 * DELETE acceptance or a missing branch is not a terminal database proof.
 * A positive branch preview_project_status=REMOVED for the exact DB is required.
 * @param {{intent: unknown, token: string, fetchImpl?: typeof fetch,
 * wait?: (duration: number) => Promise<unknown>, elapsed?: () => number}} options
 */
export async function terminatePreviewFixtureBranch({
  intent,
  token,
  fetchImpl = fetch,
  wait = setTimeout,
  elapsed = () => performance.now(),
}) {
  try {
    const plan = validateCloudIntent(intent);
    const bound = plan.request;
    if (
      bound.databaseMode !== 'ephemeral' ||
      typeof token !== 'string' ||
      !token.trim() ||
      token.length > 16_384
    )
      throw new Error();
    const started = elapsed();
    let previous = started;
    if (!Number.isFinite(started)) throw new Error();
    const remaining = () => {
      const current = elapsed();
      if (!Number.isFinite(current) || current < previous) throw new Error();
      previous = current;
      const budget = Math.ceil(60_000 - (current - started));
      if (budget <= 0) throw new Error();
      return budget;
    };
    const request = async (path, method = 'GET') => {
      const response = await fetchImpl(`https://api.supabase.com/v1/${path}`, {
        method,
        redirect: 'error',
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: AbortSignal.timeout(Math.min(15_000, remaining())),
      });
      // 404, 401/403, timeouts and malformed replies stay unconfirmed.
      if (!response.ok) throw new Error();
      const body = await response.json();
      remaining();
      return body;
    };
    const inventory = await request(`projects/${SUPABASE_PRODUCTION_PROJECT_REF}/branches`);
    if (!Array.isArray(inventory)) throw new Error();
    const matches = inventory.filter(
      (branch) =>
        branch.id === bound.supabaseBranchId || branch.project_ref === bound.supabaseProjectRef,
    );
    const branch = matches[0];
    const owned = (selected) =>
      selected?.id === bound.supabaseBranchId &&
      selected.project_ref === bound.supabaseProjectRef &&
      selected.parent_project_ref === SUPABASE_PRODUCTION_PROJECT_REF &&
      selected.persistent === false &&
      selected.is_default === false &&
      selected.with_data === false &&
      selected.git_branch === bound.branchName &&
      selected.pr_number === bound.prNumber;
    if (
      matches.length !== 1 ||
      !owned(branch) ||
      typeof branch.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(branch.name)
    )
      throw new Error();
    const observe = async () => {
      // Preview projects are not necessarily visible through /projects/{ref}.
      // Use the documented parent-project branch API and recheck full ownership
      // on every observation, including the positive terminal response.
      const selected = await request(
        `projects/${SUPABASE_PRODUCTION_PROJECT_REF}/branches/${encodeURIComponent(branch.name)}`,
      );
      if (
        !owned(selected) ||
        selected.name !== branch.name ||
        typeof selected.preview_project_status !== 'string'
      )
        throw new Error();
      return selected.preview_project_status;
    };
    // Verify that the token can positively observe the same DB before deletion.
    const before = await observe();
    if (before !== 'REMOVED') {
      const accepted = await request(`branches/${bound.supabaseBranchId}?force=true`, 'DELETE');
      if (accepted?.message !== 'ok' || Object.keys(accepted).length !== 1) throw new Error();
      for (let attempt = 0; ; attempt++) {
        if ((await observe()) === 'REMOVED') break;
        if (attempt >= 29) throw new Error();
        await wait(Math.min(1000, remaining()));
      }
    }
    remaining();
    return {
      status: 'terminated',
      runId: plan.runId,
      supabaseBranchId: bound.supabaseBranchId,
      supabaseProjectRef: bound.supabaseProjectRef,
      providerStatus: 'REMOVED',
    };
  } catch {
    throw new Error(ERROR);
  }
}
