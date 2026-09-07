# apps/product/messages

翻訳キーを追加・編集する前に `.agents/skills/i18n/SKILL.md` を読む（キー配置の判断フロー、en/ja 完全一致、用語は `docs/product/glossary.md`。正本は `scripts/lib/glossary/terms.ts`）。値だけでなく**キー名**にも旧語彙（`task` / `entry` / `tag` / `event`）を使わない。追加後は `pnpm i18n:check && pnpm copy:check:strict` を通す。
