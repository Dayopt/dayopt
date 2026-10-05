import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safePreviewNetwork } from './preview-e2e-reporter.mjs';

const EXPECTED = 3;
const FILE = 'testerarmy/journey.e2e.ts';
const TARGET = 'product-authenticated';

export function sanitizeTesterArmyReport(report, networks) {
  const safeNetworks = Array.isArray(networks)
    ? networks
        .slice(0, EXPECTED)
        .map((rows) => safePreviewNetwork(Buffer.from(JSON.stringify(rows ?? null))))
    : [];
  const rows = report?.run?.results;
  const summary = report?.run?.summary;
  const valid =
    report?.schemaVersion === 'report-1' &&
    report.run.status === 'passed' &&
    report.run.exitCode === 0 &&
    report.run.errors?.length === 0 &&
    report.run.targets?.length === 1 &&
    report.run.targets[0]?.id === TARGET &&
    summary?.discovered === EXPECTED &&
    summary.selected === EXPECTED &&
    summary.executed === EXPECTED &&
    summary.passed === EXPECTED &&
    [summary.failed, summary.skipped, summary.flaky, summary.interrupted].every(
      (value) => value === 0,
    ) &&
    Array.isArray(rows) &&
    rows.length === EXPECTED &&
    rows.every(
      (row) =>
        Number.isSafeInteger(row?.declarationIndex) &&
        row?.declarationIndex >= 0 &&
        row?.declarationIndex < EXPECTED,
    ) &&
    new Set(rows.map((row) => row?.declarationIndex)).size === EXPECTED &&
    rows.every(
      (row) =>
        row?.kind === 'test' &&
        row?.file === FILE &&
        row?.targetId === TARGET &&
        row.selected === true &&
        row?.status === 'passed' &&
        row.repeat === 0 &&
        Array.isArray(row.attempts) &&
        row.attempts.length === 1 &&
        row.attempts[0]?.index === 0 &&
        row.attempts[0]?.status === 'passed' &&
        row.attempts[0]?.secondaryErrors?.length === 0 &&
        row.attempts[0]?.cleanup === 'complete' &&
        !row.attempts[0]?.error,
    ) &&
    Array.isArray(networks) &&
    networks.length === EXPECTED &&
    safeNetworks.every((network) => Array.isArray(network) && network.length > 0);
  return {
    schema: 'testerarmy-preview-1',
    status: valid ? 'passed' : 'failed',
    expected: EXPECTED,
    tests: Array.isArray(rows)
      ? rows.slice(0, EXPECTED).map((row) => ({
          file: row?.file === FILE ? FILE : null,
          project: row?.targetId === TARGET ? TARGET : null,
          declarationIndex: Number.isSafeInteger(row?.declarationIndex)
            ? row?.declarationIndex
            : null,
          status: row?.status === 'passed' ? 'passed' : 'failed',
          attempts: row?.attempts?.length ?? 0,
        }))
      : [],
    networks: safeNetworks,
  };
}

export function isPassingTesterArmyPreviewReport(report) {
  return (
    report?.schema === 'testerarmy-preview-1' &&
    report.status === 'passed' &&
    report.expected === EXPECTED &&
    Array.isArray(report.tests) &&
    report.tests.length === EXPECTED &&
    new Set(report.tests.map((row) => row?.declarationIndex)).size === EXPECTED &&
    report.tests.every(
      (row) =>
        Number.isSafeInteger(row?.declarationIndex) &&
        row?.declarationIndex >= 0 &&
        row?.declarationIndex < EXPECTED &&
        row?.file === FILE &&
        row.project === TARGET &&
        row?.status === 'passed' &&
        row.attempts === 1,
    ) &&
    Array.isArray(report.networks) &&
    report.networks.length === EXPECTED &&
    report.networks.every(
      (rows) =>
        Array.isArray(rows) &&
        rows.length > 0 &&
        safePreviewNetwork(Buffer.from(JSON.stringify(rows ?? null))) !== null,
    )
  );
}

export function testerArmyPreviewReporter(directory) {
  return {
    name: 'dayopt-private-preview',
    async onRunFinished({ report }) {
      let networks = [];
      try {
        const files = readdirSync(join(directory, 'network')).filter((file) =>
          /^[a-f0-9-]{36}\.json$/.test(file),
        );
        if (files.length === EXPECTED)
          networks = files.map((file) =>
            safePreviewNetwork(readFileSync(join(directory, 'network', file))),
          );
      } catch {
        /* Missing bounded evidence fails closed. */
      }
      const sanitized = sanitizeTesterArmyReport(report, networks);
      writeFileSync(join(directory, 'e2e.json'), JSON.stringify(sanitized, null, 2), {
        mode: 0o600,
      });
    },
  };
}
