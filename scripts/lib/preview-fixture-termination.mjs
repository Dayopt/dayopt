import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

import { validateCloudIntent } from '../ci/preview-cloud-intent.mjs';
import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

const ERROR = 'Preview fixture database termination is unconfirmed';

/**
 * Trusted recovery caller only, after authenticating the source run/intent.
 * No CLI/HTTP entrypoint; the provider token never reaches candidate code.
 * DELETE acceptance or a missing branch is not a terminal database proof.
 * A positive provider REMOVED observation for the exact project is required.
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
    if (
      matches.length !== 1 ||
      branch.id !== bound.supabaseBranchId ||
      branch.project_ref !== bound.supabaseProjectRef ||
      branch.parent_project_ref !== SUPABASE_PRODUCTION_PROJECT_REF ||
      branch.persistent !== false ||
      branch.is_default !== false ||
      branch.with_data !== false ||
      branch.git_branch !== bound.branchName ||
      branch.pr_number !== bound.prNumber
    )
      throw new Error();
    const observe = async () => {
      const project = await request(`projects/${bound.supabaseProjectRef}`);
      if (
        !project ||
        project.ref !== bound.supabaseProjectRef ||
        project.id !== bound.supabaseProjectRef ||
        typeof project.status !== 'string'
      )
        throw new Error();
      return project.status;
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
