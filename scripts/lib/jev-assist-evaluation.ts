/** Offline acceptance calculations. Human labels are never inferred from Jev output. */
import { z } from 'zod';

const relation = z.enum(['supported', 'contradicted', 'mixed', 'unknown']);
const review = z.object({
  reviewedBy: z.string().min(1).nullable(),
  rationale: z.string().min(1),
  sourceRefs: z.array(z.string().url()).min(1),
});
const common = {
  id: z.string().min(1),
  split: z.enum(['tune', 'holdout']),
  review,
  complete: z.boolean(),
};
const contextCase = z
  .object({
    ...common,
    usefulIds: z.array(z.string()).min(1),
    requiredIds: z.array(z.string()),
    candidateIds: z.array(z.string()).min(1),
    jevTop5: z.array(z.string()).max(5),
    recencyTop5: z.array(z.string()).max(5),
    keywordTop5: z.array(z.string()).max(5),
  })
  .strict()
  .superRefine((item, ctx) => {
    const known = new Set(item.candidateIds);
    for (const ids of [
      item.candidateIds,
      item.usefulIds,
      item.requiredIds,
      item.jevTop5,
      item.recencyTop5,
      item.keywordTop5,
    ]) {
      if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
        ctx.addIssue({ code: 'custom', message: '重複または候補外のID' });
    }
    if (item.requiredIds.some((id) => !item.usefulIds.includes(id)))
      ctx.addIssue({ code: 'custom', message: '必須制約は有用資料に含める' });
  });
const claimCase = z
  .object({ ...common, expected: relation, predicted: relation.nullable(), baseline: relation })
  .strict();

export const assistEvaluationSchema = z
  .discriminatedUnion('packId', [
    z
      .object({
        schemaVersion: z.literal(1),
        packId: z.literal('context-relevance'),
        questionVersion: z.literal('v1'),
        frozenAt: z.string().datetime().nullable(),
        cases: z.array(contextCase),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        packId: z.literal('claim-support'),
        questionVersion: z.literal('v1'),
        frozenAt: z.string().datetime().nullable(),
        cases: z.array(claimCase),
      })
      .strict(),
  ])
  .superRefine((dataset, ctx) => {
    if (new Set(dataset.cases.map((item) => item.id)).size !== dataset.cases.length)
      ctx.addIssue({ code: 'custom', message: 'case IDが重複' });
  });

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const recall = (useful: string[], picks: string[]) =>
  useful.filter((id) => picks.includes(id)).length / useful.length;

export function macroF1(
  cases: Array<{ expected: z.infer<typeof relation>; predicted: z.infer<typeof relation> | null }>,
): number {
  return mean(
    relation.options.map((label) => {
      const tp = cases.filter((item) => item.expected === label && item.predicted === label).length;
      const fp = cases.filter((item) => item.expected !== label && item.predicted === label).length;
      const fn = cases.filter((item) => item.expected === label && item.predicted !== label).length;
      return 2 * tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
    }),
  );
}

export function evaluateAssistDataset(raw: unknown) {
  const dataset = assistEvaluationSchema.parse(raw);
  const holdout = dataset.cases.filter((item) => item.split === 'holdout');
  const tune = dataset.cases.filter((item) => item.split === 'tune');
  const blockers: string[] = [];
  if (!dataset.frozenAt) blockers.push('評価前の母集団・質問・基準の固定記録が必要');
  if (dataset.cases.some((item) => !item.review.reviewedBy))
    blockers.push('人手ラベルの確認が未完了');
  if (dataset.cases.some((item) => !item.complete))
    blockers.push('tuneまたはholdoutが未評価または入力不足');
  if (dataset.packId === 'context-relevance') {
    if (tune.length !== 10 || holdout.length !== 20)
      blockers.push('30 Issue（tune 10 / holdout 20）が必要');
    const cases = dataset.cases.filter((item) => item.split === 'holdout');
    const jev = mean(cases.map((item) => recall(item.usefulIds, item.jevTop5)));
    const recency = mean(cases.map((item) => recall(item.usefulIds, item.recencyTop5)));
    const keyword = mean(cases.map((item) => recall(item.usefulIds, item.keywordTop5)));
    const lostConstraints = cases.flatMap((item) =>
      item.requiredIds
        .filter(
          (id) =>
            (item.recencyTop5.includes(id) || item.keywordTop5.includes(id)) &&
            !item.jevTop5.includes(id),
        )
        .map((id) => `${item.id}:${id}`),
    );
    if (jev - Math.max(recency, keyword) + 1e-9 < 0.1) blockers.push('Recall@5の改善が0.10未満');
    if (lostConstraints.length) blockers.push('baselineが拾った必須制約の見落とし');
    return {
      packId: dataset.packId,
      verdict: blockers.length ? 'NOT_GO' : 'GO_CANDIDATE',
      blockers,
      metrics: {
        jevRecallAt5: jev,
        recencyRecallAt5: recency,
        keywordRecallAt5: keyword,
        lostConstraints,
      },
    };
  }
  if (tune.length !== 20 || holdout.length !== 40)
    blockers.push('60組（tune 20 / holdout 40）が必要');
  for (const label of relation.options) {
    if (
      dataset.cases.filter((item) => item.expected === label).length !== 15 ||
      dataset.cases.filter((item) => item.split === 'holdout' && item.expected === label).length !==
        10
    )
      blockers.push(`${label}: 全15 / holdout10組が必要`);
  }
  const cases = dataset.cases.filter((item) => item.split === 'holdout');
  if (cases.some((item) => item.predicted === null)) blockers.push('holdoutの予測が不足');
  const jev = macroF1(cases);
  const baseline = macroF1(
    cases.map((item) => ({ expected: item.expected, predicted: item.baseline })),
  );
  const falseSupport = cases
    .filter(
      (item) =>
        (item.expected === 'contradicted' || item.expected === 'unknown') &&
        item.predicted === 'supported',
    )
    .map((item) => item.id);
  if (jev < 0.75 || jev - baseline + 1e-9 < 0.1)
    blockers.push('macro-F1 0.75以上かつbaseline +0.10の条件未達');
  if (falseSupport.length) blockers.push('反証・判断不能を支持と誤分類');
  return {
    packId: dataset.packId,
    verdict: blockers.length ? 'NOT_GO' : 'GO_CANDIDATE',
    blockers,
    metrics: { jevMacroF1: jev, baselineMacroF1: baseline, falseSupport },
  };
}
