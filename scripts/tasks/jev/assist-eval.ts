/** Offline report only. Does not enable a pack or certify that human review happened. */
import { realpathSync } from 'node:fs';
import { evaluateAssistDataset } from '../../lib/jev-assist-evaluation.ts';
import { readAssistJson } from './assist.ts';

export function evaluationTemplate(packId: string) {
  const review = {
    reviewedBy: null,
    rationale: '原文に基づく分類理由を記入',
    sourceRefs: ['https://github.com/Dayopt/dayopt/issues/1'],
  };
  if (packId === 'context-relevance')
    return {
      schemaVersion: 1,
      packId,
      questionVersion: 'v1',
      frozenAt: null,
      cases: Array.from({ length: 30 }, (_, index) => ({
        id: `replace-issue-${index + 1}`,
        split: index < 10 ? 'tune' : 'holdout',
        review,
        complete: false,
        candidateIds: [],
        usefulIds: [],
        requiredIds: [],
        jevTop5: [],
        recencyTop5: [],
        keywordTop5: [],
      })),
    };
  if (packId === 'claim-support')
    return {
      schemaVersion: 1,
      packId,
      questionVersion: 'v1',
      frozenAt: null,
      cases: (['supported', 'contradicted', 'mixed', 'unknown'] as const).flatMap((expected) =>
        Array.from({ length: 15 }, (_, index) => ({
          id: `replace-${expected}-${index + 1}`,
          split: index < 5 ? 'tune' : 'holdout',
          review,
          complete: false,
          expected,
          predicted: null,
          baseline: 'unknown',
        })),
      ),
    };
  throw new Error('未対応pack');
}

export function runAssistEval(args: string[]): number {
  if (args.length === 2 && args[0] === 'template') {
    process.stdout.write(`${JSON.stringify(evaluationTemplate(args[1]), null, 2)}\n`);
    return 0;
  }
  if (args.length === 3 && args[0] === 'report' && args[1] === '--input') {
    const report = evaluateAssistDataset(readAssistJson(args[2]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  throw new Error('使い方: jev:assist-eval template <packId> | report --input <file>');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__filename)) {
  try {
    process.exitCode = runAssistEval(process.argv.slice(2));
  } catch {
    process.stderr.write('評価資料の形式・ID・原文参照を確認してください。Go判定は未実施です。\n');
    process.exitCode = 1;
  }
}
