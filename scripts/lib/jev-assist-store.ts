/** Durable, repository-local storage shared by all worktrees. Never stores credentials. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evaluateWithJev,
  JEV_MAX_INPUT_BYTES,
  JEV_MAX_TOTAL_INPUT_BYTES,
  JEV_SCHEMA_VERSION,
  jevCacheKey,
  jevInputBytes,
  normalizeJevAnswer,
  validateJevRequest,
  type JevAnnotation,
  type JevRequest,
} from './jev-adapter.ts';
import { reserveJevSend } from './jev-send-budget.ts';
export { jevStoreRoot } from './jev-send-budget.ts';

export function atomicJson(path: string, value: object): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export type AssistEvaluation = {
  source: 'cache' | 'live' | 'unavailable';
  reason: string;
  annotation: JevAnnotation | null;
};

export type AssistEvaluationOptions = {
  root: string;
  allowNetwork: boolean;
  credentialAvailable?: boolean;
  disabled?: boolean;
  now?: () => number;
  evaluate?: typeof evaluateWithJev;
};

/** Exclusive time-slot files avoid stale-lock deletion races. No waiting or automatic retry. */
export async function evaluateAssist(
  request: JevRequest,
  options: AssistEvaluationOptions,
): Promise<AssistEvaluation> {
  const unavailable = (reason: string): AssistEvaluation => ({
    source: 'unavailable',
    reason,
    annotation: null,
  });
  if (options.disabled ?? process.env.JEV_DISABLED === '1') return unavailable('disabled');
  const budget = jevInputBytes(request);
  if (validateJevRequest(request).length) return unavailable('invalid_request');
  if (budget.longest > JEV_MAX_INPUT_BYTES || budget.total > JEV_MAX_TOTAL_INPUT_BYTES)
    return unavailable('input_too_large');
  const key = jevCacheKey(request);
  const cacheDir = join(options.root, 'annotations');
  const cachePath = join(cacheDir, `${key}.json`);
  if (existsSync(cachePath)) {
    try {
      const stored: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (
        typeof stored !== 'object' ||
        stored === null ||
        !('cacheKey' in stored) ||
        stored.cacheKey !== key ||
        !('status' in stored)
      )
        return unavailable('cache_invalid');
      if (stored.status === 'evaluated') {
        if (
          !('schemaVersion' in stored) ||
          stored.schemaVersion !== JEV_SCHEMA_VERSION ||
          !('questionSetId' in stored) ||
          stored.questionSetId !== request.questionSetId ||
          !('evaluatedAt' in stored) ||
          typeof stored.evaluatedAt !== 'string' ||
          !Number.isFinite(Date.parse(stored.evaluatedAt)) ||
          !('answers' in stored) ||
          typeof stored.answers !== 'object' ||
          stored.answers === null
        )
          return unavailable('cache_invalid');
        const answers = stored.answers as Record<string, unknown>;
        if (
          Object.keys(answers).length !== Object.keys(request.questions).length ||
          Object.entries(request.questions).some(([id, question]) => {
            const answer = answers[id];
            // Normalized annotations use null for an omitted provider distribution.
            const raw =
              typeof answer === 'object' &&
              answer !== null &&
              'probabilities' in answer &&
              answer.probabilities === null
                ? { ...answer, probabilities: undefined }
                : answer;
            return !normalizeJevAnswer(question, raw);
          })
        )
          return unavailable('cache_invalid');
        return { source: 'cache', reason: 'ok', annotation: stored as JevAnnotation };
      }
    } catch {
      return unavailable('cache_unreadable');
    }
  }
  if (!options.allowNetwork) return unavailable('not_cached');
  if (!(options.credentialAvailable ?? Boolean(process.env.AI_GATEWAY_API_KEY?.trim())))
    return unavailable('missing_credentials');
  // Production transport reserves in the adapter, so legacy pack/smoke calls share the floor.
  // Injected evaluators use the same reservation here for deterministic concurrent tests.
  if (options.evaluate) {
    const blocked = reserveJevSend(options.root, (options.now ?? Date.now)());
    if (blocked) return unavailable(blocked);
  }
  const annotation = await (options.evaluate ?? evaluateWithJev)(request);
  mkdirSync(cacheDir, { recursive: true });
  atomicJson(cachePath, annotation);
  return {
    source: annotation.status === 'evaluated' ? 'live' : 'unavailable',
    reason: annotation.reasonCode,
    annotation,
  };
}
