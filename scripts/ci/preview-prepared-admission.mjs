import { readFileSync } from 'node:fs';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { validateCloudRequest } from '../lib/preview-cloud-binding.mjs';

/** Source-controlled release boundary, not an environment opt-in. A provider
 * DELETE/404, elapsed lease, or user-supplied capability flag cannot prove that
 * an in-flight Auth write has stopped. Keep paid execution closed until the
 * broker/transfer/recovery path has verified that invariant end to end. */
export function assertPreparedPreviewAdmission(request) {
  const bound = validateCloudRequest(request);
  if (bound.databaseMode === 'ephemeral')
    throw new Error(
      'Prepared Preview execution blocked: Auth termination and workflow handoff are unverified',
    );
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [path, ...rest] = process.argv.slice(2);
    if (!path || rest.length) throw new Error();
    const bytes = readFileSync(path);
    if (bytes.length > 16_384) throw new Error();
    assertPreparedPreviewAdmission(JSON.parse(bytes.toString('utf8')));
  } catch {
    console.error(
      'Prepared Preview execution blocked; do not allocate a database or inject credentials',
    );
    process.exitCode = 1;
  }
}
