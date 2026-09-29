import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

const ERROR = 'Preview fixture lifecycle failed';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATUSES = ['acquired', 'busy', 'owned', 'finished', 'closed', 'unknown', 'denied'];
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error();
}

/**
 * Trusted RPC adapter only; no credential lookup or HTTP entrypoint. rpc must
 * unwrap provider {data,error}, reject errors and connect the supplied signal to
 * the SDK's abortSignal. Hooks cannot come from HTTP/candidate input. The DB owns
 * the durable lease clock/state; this local wait clock never grants ownership.
 */
export function createFixtureLifecycle(options) {
  try {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !['rpc', 'wait', 'elapsed'].includes(key))
    )
      throw new Error();
    const { rpc, wait = setTimeout, elapsed = () => performance.now() } = options;
    if (![rpc, wait, elapsed].every((value) => typeof value === 'function')) throw new Error();
    return async function withLifecycle(binding, execute) {
      try {
        exact(binding, ['key', 'intentDigest', 'operation']);
        if (
          typeof binding.key !== 'string' ||
          typeof binding.intentDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(binding.intentDigest) ||
          !['provision', 'cleanup', 'recover'].includes(binding.operation) ||
          typeof execute !== 'function'
        )
          throw new Error();
        const parts = binding.key.split(':');
        const [ref, runId] = parts;
        if (
          parts.length !== 2 ||
          !/^[a-z]{20}$/.test(ref) ||
          !UUID.test(runId) ||
          /^00000000-0000-0000-0000-00000000000[01]$/.test(runId) ||
          [SUPABASE_PRODUCTION_PROJECT_REF, 'tilwaprottpyhlfoggbb'].includes(ref)
        )
          throw new Error();
        const { intentDigest, operation } = binding;
        const owner = randomUUID();
        const call = async (action, success = null) => {
          const result = await rpc(
            'preview_fixture_lifecycle_v1',
            {
              p_database_ref: ref,
              p_run_id: runId,
              p_intent_digest: intentDigest,
              p_owner_id: owner,
              p_action: action,
              p_operation: operation,
              p_success: success,
            },
            { signal: AbortSignal.timeout(15_000) },
          );
          exact(result, ['status']);
          if (!STATUSES.includes(result.status)) throw new Error();
          return result.status;
        };
        const started = elapsed();
        if (!Number.isFinite(started)) throw new Error();
        let last = started;
        for (let attempt = 0; ; attempt++) {
          const now = elapsed();
          if (!Number.isFinite(now) || now < last || now - started >= 15_000 || attempt > 30)
            throw new Error();
          last = now;
          const status = await call('claim');
          if (status === 'acquired') break;
          if (status !== 'busy') throw new Error();
          const after = elapsed();
          if (!Number.isFinite(after) || after < last || after - started >= 15_000 || attempt >= 29)
            throw new Error();
          last = after;
          await wait(Math.min(500, 15_000 - (after - started)));
        }
        let active = true;
        let failed = false;
        let result;
        let pendingGuards = 0;
        const beforeMutation = async () => {
          try {
            if (!active || failed) throw new Error();
            pendingGuards++;
            try {
              if ((await call('guard')) !== 'owned' || !active || failed) throw new Error();
            } finally {
              pendingGuards--;
            }
          } catch {
            failed = true;
            throw new Error(ERROR);
          }
        };
        try {
          result = await execute({ beforeMutation });
        } catch {
          failed = true;
        } finally {
          active = false;
          if (pendingGuards !== 0) failed = true;
        }
        const finish = await call('finish', !failed);
        if (finish !== 'finished' || failed) throw new Error();
        return result;
      } catch {
        throw new Error(ERROR);
      }
    };
  } catch {
    throw new Error(ERROR);
  }
}

/** Trusted server client only. No credential lookup or request-controlled hooks. */
export function createSupabaseFixtureLifecycle({ client, wait = undefined, elapsed = undefined }) {
  try {
    if (!client || typeof client.rpc !== 'function') throw new Error();
    return createFixtureLifecycle({
      ...(wait === undefined ? {} : { wait }),
      ...(elapsed === undefined ? {} : { elapsed }),
      rpc: async (name, args, { signal }) => {
        try {
          // The installed SDK carries this signal through PostgREST fetch.
          const result = await client.rpc(name, args).abortSignal(signal);
          if (!result || result.error || result.data === null || result.data === undefined)
            throw new Error();
          return result.data;
        } catch {
          throw new Error(ERROR);
        }
      },
    });
  } catch {
    throw new Error(ERROR);
  }
}
