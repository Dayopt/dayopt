# Auth email previews

The deployed Supabase Auth email templates are the source of truth:

- `supabase/functions/send-auth-email/ConfirmEmail.tsx`
- `supabase/functions/send-auth-email/EmailChangeEmail.tsx`
- `supabase/functions/send-auth-email/MagicLinkEmail.tsx`
- `supabase/functions/send-auth-email/PasswordResetEmail.tsx`
- `supabase/functions/send-auth-email/PasswordChangedEmail.tsx`
- `supabase/functions/send-auth-email/styles.tsx`
- `supabase/functions/send-auth-email/subjects.ts`

The same source cannot be imported directly by both runtimes because the Edge Function and Product
app resolve React Email through different package entry points. The four same-named files in this
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
