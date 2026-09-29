import { createHash } from 'node:crypto';

/** Sample distinct source sites before observing any test results. */
export function selectMutationCandidates(candidates, seed, count = 20) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('Seed must be an unsigned 32-bit integer.');
  }
  if (!Number.isSafeInteger(count) || count < 1 || candidates.length < count) {
    throw new RangeError(`Need at least ${count} mutation sites; found ${candidates.length}.`);
  }
  const sites = new Set(candidates.map(({ file, start, end }) => `${file}:${start}:${end}`));
  if (sites.size !== candidates.length) throw new Error('Duplicate mutation sites.');
  const shuffled = [...candidates];
  let state = seed;
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/** Keep individual test identities: equal totals can conceal a missing/replaced test. */
export function summarizeMutationRun(parsed, processResult) {
  const suites = Array.isArray(parsed?.testResults) ? parsed.testResults : [];
  const tests = suites.flatMap((suite) =>
    (suite.assertionResults ?? []).map((test) => ({
      id: `${suite.name}\0${test.fullName}`,
      status: test.status,
      messages: test.failureMessages ?? [],
    })),
  );
  const identities = tests.map((test) => test.id).sort();
  const failed = tests.filter((test) => test.status === 'failed');
  const passed = tests.filter((test) => test.status === 'passed').length;
  const pending = tests.length - passed - failed.length;
  return {
    exitCode: processResult.status,
    signal: processResult.signal ?? null,
    error: processResult.error?.message,
    passed,
    failed: failed.length,
    pending,
    identities,
    reportComplete:
      suites.length > 0 &&
      tests.length > 0 &&
      new Set(identities).size === identities.length &&
      parsed.numTotalTests === tests.length &&
      parsed.numPassedTests === passed &&
      parsed.numFailedTests === failed.length &&
      parsed.numPendingTests === pending &&
      !(parsed.numRuntimeErrorTestSuites > 0) &&
      suites.every(
        (suite) =>
          !suite.message &&
          (suite.status === 'passed' ||
            (suite.status === 'failed' &&
              suite.assertionResults.some((t) => t.status === 'failed'))),
      ),
    failures: failed.map((test) => ({ name: test.id.split('\0')[1], messages: test.messages })),
  };
}

export function isSuccessfulMutationRun(result) {
  return (
    result.reportComplete === true &&
    result.exitCode === 0 &&
    !result.signal &&
    !result.error &&
    result.passed > 0 &&
    result.failed === 0 &&
    result.pending === 0
  );
}

/** A launch/collection error is not proof that a behavioral test caught a mutant. */
export function classifyMutationRun(result, baseline) {
  if (
    !isSuccessfulMutationRun(baseline) ||
    !result.reportComplete ||
    result.signal ||
    result.error ||
    result.pending !== 0 ||
    JSON.stringify(result.identities) !== JSON.stringify(baseline.identities)
  ) {
    return 'inconclusive';
  }
  if (isSuccessfulMutationRun(result)) return 'survived';
  if (
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    result.failed > 0 &&
    result.failures.some((failure) =>
      failure.messages.some((message) =>
        /AssertionError|expected .*|to (?:be|equal|throw)/s.test(message),
      ),
    )
  ) {
    return 'killed';
  }
  return 'inconclusive';
}

/** Reject a stale selection instead of applying its offsets to a different source. */
export function applyMutation(source, mutant) {
  if (
    createHash('sha256').update(source).digest('hex') !== mutant.sha256 ||
    source.slice(mutant.start, mutant.end) !== mutant.before ||
    mutant.before === mutant.after
  ) {
    throw new Error(`Mutation source drift: ${mutant.file}:${mutant.line}`);
  }
  return source.slice(0, mutant.start) + mutant.after + source.slice(mutant.end);
}
