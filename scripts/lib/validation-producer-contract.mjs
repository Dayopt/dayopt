/**
 * Validation の trusted producer と repository ruleset の共有契約。
 * producer を変更できる path と review 依頼前に完了を待つ required context を、
 * evidence evaluator と protected-path gate が同じ正本から読む。
 */

export const VALIDATION_PRODUCER_DEFINITIONS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/actions/setup/action.yml',
  'package.json',
  'scripts/ci/check.mjs',
  'scripts/ci/impact.mjs',
]);

export const REVIEW_REQUIRED_ACTIONS_JOBS = Object.freeze([
  '🔍 Static Checks',
  '📦 Unit Tests',
  '🧪 Integration Tests',
]);

export const REVIEW_REQUIRED_STATUS_CONTEXTS = Object.freeze(['Vercel – product', 'Vercel – web']);
