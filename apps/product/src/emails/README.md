# Auth email previews

The repository Auth email templates are canonical; the source/destination declarations are shown below from the sync registry. Deployment state is verified separately.

The same source cannot be imported directly by both runtimes because the Edge Function and Product
app resolve React Email through different package entry points. The template copies in this
directory, `auth-email-styles.generated.ts`, and `auth-email-subjects.generated.ts` are generated
Storybook/test artifacts. They are not used by the production delivery path and must not be edited
directly.

After changing a canonical template or its styles, run:

```bash
pnpm auth-email:sync
pnpm auth-email:check
```

`pnpm check` also runs the drift check. The preview preserves source structure, copy, and link
semantics, but byte-identical HTML is not promised because the Edge and Product React Email versions
differ.

`supabase/functions/send-auth-email/index.ts` owns hook signature verification, locale lookup,
action routing, rendering, and Resend delivery. Following R-01, its only shared Edge Function
dependency is the active `../_shared/types.ts` module.

## 機械取得する現状

<!-- docs-live:facts:start -->

抽出対象の登録は [scripts/lib/docs-live/facts.ts](../../../../scripts/lib/docs-live/facts.ts)。現在の一覧は `pnpm docs:read apps/product/src/emails/README.md` で生成して読む。

<!-- docs-live:facts:end -->
