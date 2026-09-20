import { test as base, expect, type Request, type Response } from '@playwright/test';

/**
 * HTTP batch 数ではなく、ブラウザが送った procedure 数を操作前から数える。
 * URL / 入力 / token は保存せず、件数だけを結果へ添付する。
 */
export const test = base.extend<{
  trpcProcedureBudget: number;
  trpcBudgetObserver: void;
}>({
  trpcProcedureBudget: [Number.POSITIVE_INFINITY, { option: true }],
  trpcBudgetObserver: [
    async ({ page, trpcProcedureBudget }, use, testInfo) => {
      const counts: Record<string, number> = {};
      let rateLimitedResponses = 0;
      let mixedBatchResponses = 0;
      const onRequest = (request: Request) => {
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/trpc/')) return;
        for (const procedure of decodeURIComponent(pathname.slice('/api/trpc/'.length)).split(
          ',',
        )) {
          counts[procedure] = (counts[procedure] ?? 0) + 1;
        }
      };
      const onResponse = (response: Response) => {
        if (!new URL(response.url()).pathname.startsWith('/api/trpc/')) return;
        if (response.status() === 429) rateLimitedResponses += 1;
        // 一部だけ429になったbatchは207になる。成功に紛れた失敗も許さない。
        if (response.status() === 207) mixedBatchResponses += 1;
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      await use();
      // 保存やreload直後に残る通信の応答も観測してから予算を確定する。
      if (testInfo.status === 'passed') {
        await page.waitForLoadState('networkidle', { timeout: 5_000 });
      }
      page.off('request', onRequest);
      page.off('response', onResponse);
      if (testInfo.status === 'skipped') return;
      const procedures = Object.values(counts).reduce((total, count) => total + count, 0);
      await testInfo.attach('trpc-procedure-budget', {
        body: JSON.stringify({
          procedures,
          budget: trpcProcedureBudget,
          rateLimitedResponses,
          mixedBatchResponses,
          counts,
        }),
        contentType: 'application/json',
      });
      expect(procedures, '実際の tRPC 通信を観測できていること').toBeGreaterThan(0);
      expect(procedures, 'tRPC procedure 数の回帰').toBeLessThanOrEqual(trpcProcedureBudget);
      expect(rateLimitedResponses, 'tRPC rate limit').toBe(0);
      expect(mixedBatchResponses, 'tRPC batch内の部分失敗').toBe(0);
    },
    { auto: true },
  ],
});
