-- Delete rooms (and, by cascade, their players, nominations and queue) 48 hours after
-- creation. Runs hourly via pg_cron where available (Supabase has it; plain Postgres
-- test clusters do not, so scheduling is skipped there).

create or replace function private.purge_old_rooms(p_max_age interval default interval '48 hours')
returns int
language plpgsql volatile set search_path = ''
as $$
declare
  n int;
begin
  -- Break rematch links into rooms being deleted is handled by ON DELETE SET NULL.
  delete from private.rooms r where r.created_at < now() - p_max_age;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function private.purge_old_rooms(interval) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'last-track-purge-old-rooms';
    perform cron.schedule('last-track-purge-old-rooms', '17 * * * *', 'select private.purge_old_rooms()');
  end if;
end $$;
