-- Isolated database only, with the pre-migration schema.
INSERT INTO auth.users(id,email,raw_user_meta_data)
VALUES ('a1234567-0000-4000-8000-000000000001','derived-fixture@example.invalid','{}');
INSERT INTO public.plans(id,user_id,title,start_at,end_at,skipped_at) VALUES
 ('a1234567-0000-4000-8000-000000000011','a1234567-0000-4000-8000-000000000001','linked fixture','2025-01-01 09:00Z','2025-01-01 10:00Z',NULL),
 ('a1234567-0000-4000-8000-000000000012','a1234567-0000-4000-8000-000000000001','old skipped fixture','2025-01-01 11:00Z','2025-01-01 12:00Z','2025-01-02 00:00Z');
INSERT INTO public.records(id,user_id,title,start_at,end_at,source,plan_id)
VALUES ('a1234567-0000-4000-8000-000000000021','a1234567-0000-4000-8000-000000000001','linked record','2025-01-01 09:00Z','2025-01-01 10:00Z','from_plan','a1234567-0000-4000-8000-000000000011');
CREATE TABLE public.derived_migration_snapshot AS
SELECT 'plan'::text AS kind, id, to_jsonb(p) - 'skipped_at' AS retained FROM public.plans p
UNION ALL
SELECT 'record', id, to_jsonb(r) - 'plan_id' FROM public.records r;

INSERT INTO public.undo_receipts(id,user_id,operation_id,command_name,undo_expires_at,recorded_effect_count)
VALUES ('a1234567-0000-4000-8000-000000000031','a1234567-0000-4000-8000-000000000001',gen_random_uuid(),'old skip',now()+interval '1 hour',1);
INSERT INTO public.undo_receipt_effects(id,user_id,receipt_id,plan_id,effect_kind)
VALUES ('a1234567-0000-4000-8000-000000000032','a1234567-0000-4000-8000-000000000001','a1234567-0000-4000-8000-000000000031','a1234567-0000-4000-8000-000000000012','update');
INSERT INTO public.undo_receipt_field_changes(effect_id,user_id,field_name,before_value,after_value)
VALUES ('a1234567-0000-4000-8000-000000000032','a1234567-0000-4000-8000-000000000001','skipped_at','null','null'),
('a1234567-0000-4000-8000-000000000032','a1234567-0000-4000-8000-000000000001','title','"must not apply"','"old skipped fixture"');

INSERT INTO public.undo_receipts(id,user_id,operation_id,command_name,undo_expires_at,recorded_effect_count)
VALUES ('a1234567-0000-4000-8000-000000000041','a1234567-0000-4000-8000-000000000001',gen_random_uuid(),'ordinary title',now()+interval '1 hour',1);
INSERT INTO public.undo_receipt_effects(id,user_id,receipt_id,record_id,effect_kind)
VALUES ('a1234567-0000-4000-8000-000000000042','a1234567-0000-4000-8000-000000000001','a1234567-0000-4000-8000-000000000041','a1234567-0000-4000-8000-000000000021','update');
INSERT INTO public.undo_receipt_field_changes(effect_id,user_id,field_name,before_value,after_value)
VALUES ('a1234567-0000-4000-8000-000000000042','a1234567-0000-4000-8000-000000000001','title','"ordinary undo restored"','"linked record"');
