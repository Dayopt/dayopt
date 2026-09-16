import { setProjectAnnotations } from 'storybook/preview-api';
import { beforeAll, expect } from 'vitest';

// addon-vitest の自動登録が終わってから拡張する。framework の RSC 等の設定も保持する。
beforeAll(() => {
  setProjectAnnotations([
    globalThis.globalProjectAnnotations,
    {
      parameters: { testTheme: 'dark' },
      afterEach: () => {
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.style.colorScheme).toBe('dark');
      },
    },
  ]);
});
