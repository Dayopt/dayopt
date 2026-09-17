BEGIN;

-- welcome メールを「1 ユーザー 1 通」に固定するためのマーク。
--
-- 送信ログのテーブルは作らない。app_trial_started_at と同じく server-owned な列を 1 本足し、
-- `UPDATE ... WHERE welcome_email_sent_at IS NULL` の更新行数が 1 の時だけ送る形にする
-- （20260907233848_single_plan_trial.sql の startAppTrial と同型）。サインアップ直後は
-- callback と confirm の両方から同じ関数を呼びうるので、アプリ側の分岐ではなく DB に潰させる。
ALTER TABLE public.profiles
  ADD COLUMN welcome_email_sent_at timestamptz;

COMMENT ON COLUMN public.profiles.welcome_email_sent_at IS
  'welcome メールを送信した時刻。server-owned。NULL の行を conditional UPDATE で掴んだ側だけが送信する';

-- 既存ユーザーは「送信済み」として埋める。
-- これを入れないと、この migration より前からいる全員が次のサインインで welcome を受け取る
-- （発火点はサインアップ専用ではなく、session が張れた時だから）。過去に遡って歓迎はしない。
UPDATE public.profiles
  SET welcome_email_sent_at = now()
  WHERE welcome_email_sent_at IS NULL;

-- 本人にも書かせない。クライアントから NULL へ戻せると welcome を何度でも再送できてしまう。
REVOKE INSERT (welcome_email_sent_at),
       UPDATE (welcome_email_sent_at)
  ON public.profiles FROM PUBLIC, anon, authenticated;

COMMIT;
