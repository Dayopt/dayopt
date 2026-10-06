import { z } from 'zod';

const label = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[@\r\n]|:\/\//.test(value));
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const presence = z.enum(['unknown', 'user_confirmed']);
const location = z
  .object({
    vault: z.enum(['human', 'ci']).nullable(),
    item: label.nullable(),
    presence_status: presence,
    locator_status: z.enum(['complete', 'incomplete']),
    reason: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict()
  .refine((entry) => entry.locator_status !== 'complete' || !!(entry.vault && entry.item), {
    message: 'A complete locator needs a Vault and exact item name',
  })
  .refine((entry) => entry.locator_status !== 'incomplete' || !!entry.reason, {
    message: 'An incomplete locator needs its reason',
  });

export const humanItems = z
  .object({
    confirmation_scope: z.literal(
      'item_presence_and_service_use_only_not_provider_settings_or_replica_match',
    ),
    source: z.string().min(1),
    confirmed_by: label.optional(),
    verified_at: date.optional(),
    items: z.record(z.string(), location),
  })
  .strict()
  .refine(
    (group) =>
      !Object.values(group.items).some((entry) => entry.presence_status === 'user_confirmed') ||
      !!(group.confirmed_by && group.verified_at),
    {
      message: 'Confirmed item presence needs an actor and date',
    },
  );

export const ciItems = z
  .object({
    vault: z.literal('ci'),
    source: z.string().min(1),
    presence_status: presence,
    confirmed_by: label.optional(),
    verified_at: date.optional(),
    confirmation_scope: z.literal('item_names_and_presence_only'),
    contract_refs: z.array(z.string()).min(1),
    field_presence: z.literal('unverified'),
    provider_permissions: z.literal('unverified'),
    expiry: z.literal('unverified'),
    replica_match: z.literal('unverified'),
    items: z
      .array(label)
      .min(1)
      .refine((items) => new Set(items).size === items.length),
  })
  .strict()
  .refine(
    (group) =>
      group.presence_status !== 'user_confirmed' || !!(group.confirmed_by && group.verified_at),
    {
      message: 'Confirmed item presence needs an actor and date',
    },
  );

export type ItemResources = {
  human_onepassword_items?: z.infer<typeof humanItems>;
  ci_onepassword_items?: z.infer<typeof ciItems>;
};

export function itemLocations(resources: ItemResources, service?: string) {
  const human = resources.human_onepassword_items;
  const ci = resources.ci_onepassword_items;
  const confirmation = (
    group: { confirmed_by?: string; verified_at?: string },
    status: string,
  ) => ({
    confirmed_by: status === 'user_confirmed' ? group.confirmed_by : undefined,
    verified_at: status === 'user_confirmed' ? group.verified_at : undefined,
  });
  return [
    ...Object.entries(human?.items ?? {})
      .filter(([name]) => !service || service === 'onepassword' || service === name)
      .map(([name, entry]) => ({
        service: name,
        ...entry,
        ...confirmation(human!, entry.presence_status),
        source: human!.source,
        verification_scope: human!.confirmation_scope,
      })),
    ...(!service || service === 'onepassword' ? (ci?.items ?? []) : []).map((item) => ({
      service: 'onepassword',
      vault: ci!.vault,
      item,
      presence_status: ci!.presence_status,
      locator_status: 'complete',
      ...confirmation(ci!, ci!.presence_status),
      source: ci!.source,
      verification_scope: ci!.confirmation_scope,
    })),
  ];
}
