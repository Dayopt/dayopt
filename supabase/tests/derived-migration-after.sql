-- Works in both expand and contract stages. IDs, counts, and all retained values must match.
DO $test$
DECLARE differences bigint; apply_op uuid := gen_random_uuid();
BEGIN
 PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
 IF EXISTS (SELECT 1 FROM public.undo_receipts WHERE id='a1234567-0000-4000-8000-000000000031') THEN
   BEGIN
     PERFORM private.apply_undo_receipt_v1('a1234567-0000-4000-8000-000000000001','a1234567-0000-4000-8000-000000000031',gen_random_uuid());
     RAISE EXCEPTION 'old skip receipt was accepted';
   EXCEPTION WHEN SQLSTATE 'DR008' THEN NULL;
   END;
 END IF;
 IF EXISTS (SELECT 1 FROM public.undo_receipts WHERE id='a1234567-0000-4000-8000-000000000041') THEN
   BEGIN
     PERFORM private.apply_undo_receipt_v1('a1234567-0000-4000-8000-000000000001','a1234567-0000-4000-8000-000000000041',apply_op);
     PERFORM private.apply_undo_receipt_v1('a1234567-0000-4000-8000-000000000001','a1234567-0000-4000-8000-000000000041',apply_op);
     IF (SELECT title FROM public.records WHERE id='a1234567-0000-4000-8000-000000000021') <> 'ordinary undo restored' THEN
       RAISE EXCEPTION 'ordinary undo failed';
     END IF;
     RAISE EXCEPTION 'rollback successful ordinary undo fixture' USING ERRCODE='ZT001';
   EXCEPTION WHEN SQLSTATE 'ZT001' THEN NULL;
   END;
 END IF;
 WITH current_rows AS (
 SELECT 'plan'::text AS kind, id, to_jsonb(p) - 'skipped_at' AS retained FROM public.plans p
 UNION ALL SELECT 'record', id, to_jsonb(r) - 'plan_id' FROM public.records r
 ), missing AS (SELECT * FROM public.derived_migration_snapshot EXCEPT SELECT * FROM current_rows),
 added AS (SELECT * FROM current_rows EXCEPT SELECT * FROM public.derived_migration_snapshot)
 SELECT (SELECT count(*) FROM missing) + (SELECT count(*) FROM added) INTO differences;
 IF differences <> 0 THEN RAISE EXCEPTION 'migration changed % retained rows', differences; END IF;
END;
$test$;
