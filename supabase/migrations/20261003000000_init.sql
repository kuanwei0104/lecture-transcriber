-- 即時課堂轉錄：帳號、課程紀錄雲端同步、AI 用量上限、音檔儲存
-- 在 Supabase 後台的 SQL Editor 貼上執行一次即可（或用 supabase db push）

-- ── 課程紀錄 ─────────────────────────────────────────────
create table if not exists public.lectures (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default '',
  started_at  timestamptz,
  data        jsonb not null default '{}'::jsonb,   -- 逐字稿、順稿、圖解、提問…（音檔另存在 Storage）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists lectures_user_updated on public.lectures (user_id, updated_at desc);

alter table public.lectures enable row level security;

drop policy if exists "own lectures" on public.lectures;
create policy "own lectures" on public.lectures
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── AI 用量（每人每天的呼叫次數，避免費用失控）──────────
create table if not exists public.ai_usage (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null default current_date,
  calls    integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage
  for select to authenticated
  using (user_id = auth.uid());

-- 只有後端函式（service role）能加次數；超過上限回傳 -1 且不計入
create or replace function public.bump_ai_usage(p_user uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into ai_usage (user_id, day, calls) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set calls = ai_usage.calls + 1
  returning calls into n;

  if n > p_limit then
    update ai_usage set calls = calls - 1 where user_id = p_user and day = current_date;
    return -1;
  end if;
  return n;
end;
$$;

revoke all on function public.bump_ai_usage(uuid, integer) from public, anon, authenticated;
grant execute on function public.bump_ai_usage(uuid, integer) to service_role;

-- ── 音檔（私人 bucket，路徑第一層是使用者 id）──────────────
insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do nothing;

drop policy if exists "own audio read" on storage.objects;
create policy "own audio read" on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own audio insert" on storage.objects;
create policy "own audio insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own audio update" on storage.objects;
create policy "own audio update" on storage.objects
  for update to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own audio delete" on storage.objects;
create policy "own audio delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
