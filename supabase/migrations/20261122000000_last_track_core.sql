-- Last Track core schema.
--
-- Security model
-- * Every real table lives in schema `private`, which the API roles (anon, authenticated)
--   cannot even reach. PostgREST and Realtime therefore cannot serve them.
-- * Clients talk to the database only through the SECURITY DEFINER functions below,
--   each of which checks auth.uid(), room membership, host role and room state.
-- * The only client-readable table is public.room_public_state: one JSON document per
--   room containing exactly the fields the brief classes as public. It is rebuilt by
--   private.refresh_public_state() after every mutation and is what Realtime streams.
-- * Unplayed nominations, their owners, the locked order and per-player outstanding
--   counts never leave the private schema. The host device receives one Apple Music
--   song ID at a time, at the moment that track starts.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table private.rooms (
  id                     uuid primary key default gen_random_uuid(),
  code                   text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  host_participant_id    uuid,
  song_quota             int  not null check (song_quota in (3, 4, 5)),
  -- Product decision: Australian Apple Music catalogue only.
  storefront             text not null default 'au' check (storefront = 'au'),
  status                 text not null default 'lobby'
                           check (status in ('lobby', 'playing', 'finished')),
  -- lobby -> ready -> playing <-> paused -> reveal -> playing ... -> finished
  -- playing/paused -> failed -> playing (retry) | reveal (marked unplayable)
  phase                  text not null default 'lobby'
                           check (phase in ('lobby', 'ready', 'playing', 'paused',
                                            'reveal', 'failed', 'finished')),
  current_position       int,
  winner_participant_id  uuid,
  rematch_room_id        uuid references private.rooms (id) on delete set null,
  created_at             timestamptz not null default now(),
  locked_at              timestamptz,
  finished_at            timestamptz
);

create table private.participants (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references private.rooms (id) on delete cascade,
  user_id      uuid not null,
  nickname     text not null check (char_length(nickname) between 1 and 20),
  is_host      boolean not null default false,
  joined_at    timestamptz not null default now(),
  removed_at   timestamptz,
  unique (room_id, user_id)
);
create unique index participants_active_nickname
  on private.participants (room_id, lower(nickname)) where removed_at is null;

alter table private.rooms
  add constraint rooms_host_fk foreign key (host_participant_id)
  references private.participants (id) deferrable initially deferred;

create table private.nominations (
  id                   uuid primary key default gen_random_uuid(),
  room_id              uuid not null references private.rooms (id) on delete cascade,
  participant_id       uuid not null references private.participants (id) on delete cascade,
  apple_music_song_id  text not null check (apple_music_song_id ~ '^[0-9]{1,20}$'),
  title                text not null check (char_length(title) between 1 and 300),
  artist               text not null check (char_length(artist) between 1 and 300),
  duration_ms          int check (duration_ms is null or duration_ms between 1000 and 3600000),
  artwork_url          text check (artwork_url is null or char_length(artwork_url) <= 1000),
  created_at           timestamptz not null default now(),
  -- The atomic duplicate guard required by the brief.
  unique (room_id, apple_music_song_id)
);
create index nominations_participant on private.nominations (participant_id);

create table private.queue_entries (
  room_id        uuid not null references private.rooms (id) on delete cascade,
  position       int  not null check (position >= 1),
  nomination_id  uuid not null unique references private.nominations (id),
  status         text not null default 'queued'
                   check (status in ('queued', 'playing', 'completed', 'unplayable')),
  started_at     timestamptz,
  resumed_at     timestamptz,          -- set while audio is running
  play_accum_ms  bigint not null default 0,  -- audio time accumulated before resumed_at
  completed_at   timestamptz,
  failure_count  int not null default 0,
  primary key (room_id, position)
);

-- ---------------------------------------------------------------------------
-- Client-readable projection
-- ---------------------------------------------------------------------------

create table public.room_public_state (
  room_id     uuid primary key references private.rooms (id) on delete cascade,
  revision    bigint not null default 0,
  state       jsonb  not null,
  updated_at  timestamptz not null default now()
);

alter table public.room_public_state enable row level security;
revoke all on public.room_public_state from public, anon, authenticated;
grant select on public.room_public_state to authenticated;

-- Membership check used by RLS. SECURITY DEFINER so it can read private tables;
-- it only ever answers "is the caller an active member of this room".
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.participants p
    where p.room_id = p_room_id and p.user_id = auth.uid() and p.removed_at is null
  );
$$;
revoke all on function public.is_room_member(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;

create policy room_public_state_members_read on public.room_public_state
  for select to authenticated using (public.is_room_member(room_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.room_public_state;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Internal helpers (private schema, not callable by clients)
-- ---------------------------------------------------------------------------

-- Unbiased uniform integer in [0, n) from the CSPRNG, by rejection sampling.
create or replace function private.random_below(n int)
returns int
language plpgsql volatile set search_path = ''
as $$
declare
  v      bigint;
  bound  bigint;
begin
  if n is null or n < 1 then
    raise exception 'random_below: n must be >= 1';
  end if;
  bound := 4294967296 - (4294967296 % n);
  loop
    v := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    if v < bound then
      return (v % n)::int;
    end if;
  end loop;
end;
$$;

create or replace function private.new_room_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 symbols, no 0/O/1/I
  bytes     bytea;
  candidate text;
begin
  loop
    bytes := extensions.gen_random_bytes(6);
    candidate := '';
    for i in 0..5 loop
      candidate := candidate || substr(alphabet, (get_byte(bytes, i) & 31) + 1, 1);
    end loop;
    if not exists (select 1 from private.rooms r where r.code = candidate) then
      return candidate;
    end if;
  end loop;
end;
$$;

create or replace function private.clean_nickname(p text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  n text := btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'));
begin
  if char_length(n) < 1 or char_length(n) > 20 then
    raise exception 'invalid_nickname' using errcode = 'P0001';
  end if;
  return n;
end;
$$;

-- The caller's active participant row in a room, or an error.
create or replace function private.require_member(p_room_id uuid)
returns private.participants
language plpgsql stable set search_path = ''
as $$
declare
  me private.participants;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  select * into me from private.participants p
  where p.room_id = p_room_id and p.user_id = auth.uid() and p.removed_at is null;
  if not found then
    raise exception 'not_a_member' using errcode = 'P0001';
  end if;
  return me;
end;
$$;

create or replace function private.require_host(p_room_id uuid)
returns private.participants
language plpgsql stable set search_path = ''
as $$
declare
  me private.participants := private.require_member(p_room_id);
begin
  if not me.is_host then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  return me;
end;
$$;

-- Milliseconds of audio actually played for a queue entry, per the server clock.
create or replace function private.elapsed_ms(e private.queue_entries)
returns bigint
language sql stable set search_path = ''
as $$
  select e.play_accum_ms
       + case when e.resumed_at is null then 0
              else greatest(0, (extract(epoch from (clock_timestamp() - e.resumed_at)) * 1000)::bigint)
         end;
$$;

-- Rebuild the public JSON document for a room. This function is the privacy boundary:
-- anything not written here is never visible to clients.
create or replace function private.refresh_public_state(p_room_id uuid)
returns void
language plpgsql volatile set search_path = ''
as $$
declare
  r            private.rooms;
  players      jsonb;
  history      jsonb;
  now_playing  jsonb := null;
  last_reveal  jsonb := null;
  winner       jsonb := null;
  rematch_code text  := null;
  remaining_count int := 0;
  remaining_ms    bigint := 0;
  is_estimate     boolean := false;
  avg_ms          bigint;
  cur             private.queue_entries;
  cur_nom         private.nominations;
  total_tracks    int;
begin
  select * into r from private.rooms where id = p_room_id;
  if not found then
    return;
  end if;

  -- Players. During play, status is derived only from revealed (completed) tracks:
  -- a player is OUT once none of their entries remain un-completed. The current,
  -- unrevealed track counts as remaining, so nothing leaks before the reveal.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'nickname', p.nickname,
           'is_host', p.is_host,
           -- Lobby only: how many songs each player has picked (e.g. 4/5). Nulled once the
           -- game is locked so per-player counts can never leak during play.
           'submitted_count', case when r.status = 'lobby' then
              (select count(*) from private.nominations x where x.participant_id = p.id) end,
           'status', case
              when r.status = 'lobby' then 'in'
              when p.id = r.winner_participant_id then 'winner'
              when exists (
                select 1 from private.queue_entries q
                join private.nominations n on n.id = q.nomination_id
                where q.room_id = r.id and n.participant_id = p.id
                  and q.status in ('queued', 'playing')) then 'in'
              else 'out' end
         ) order by p.joined_at, p.id), '[]'::jsonb)
    into players
  from private.participants p
  where p.room_id = r.id and p.removed_at is null;

  -- Played history (completed or unplayable), in play order, with owners.
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', q.position,
           'song_id', n.apple_music_song_id,
           'title', n.title,
           'artist', n.artist,
           'artwork_url', n.artwork_url,
           'duration_ms', n.duration_ms,
           'owner_id', p.id,
           'owner_nickname', p.nickname,
           'outcome', case when q.status = 'unplayable' then 'unplayable' else 'played' end,
           'owner_eliminated', not exists (
              select 1 from private.queue_entries q2
              join private.nominations n2 on n2.id = q2.nomination_id
              where q2.room_id = r.id and n2.participant_id = p.id and q2.position > q.position)
         ) order by q.position), '[]'::jsonb)
    into history
  from private.queue_entries q
  join private.nominations n on n.id = q.nomination_id
  join private.participants p on p.id = n.participant_id
  where q.room_id = r.id and q.status in ('completed', 'unplayable');

  if r.status = 'lobby' then
    total_tracks := r.song_quota * (select count(*) from private.participants p
                                    where p.room_id = r.id and p.removed_at is null);
  else
    total_tracks := (select count(*) from private.queue_entries q where q.room_id = r.id);
  end if;

  if r.status <> 'lobby' then
    -- Average known duration stands in for missing catalogue durations.
    select coalesce(avg(n.duration_ms)::bigint, 210000) into avg_ms
    from private.queue_entries q join private.nominations n on n.id = q.nomination_id
    where q.room_id = r.id and n.duration_ms is not null;

    -- Convention: remaining_count INCLUDES the track currently playing / paused / failed.
    select count(*),
           coalesce(sum(coalesce(n.duration_ms, avg_ms)), 0),
           bool_or(n.duration_ms is null)
      into remaining_count, remaining_ms, is_estimate
    from private.queue_entries q join private.nominations n on n.id = q.nomination_id
    where q.room_id = r.id and q.status in ('queued', 'playing');
    is_estimate := coalesce(is_estimate, false);

    if r.phase in ('playing', 'paused', 'failed') then
      select * into cur from private.queue_entries q
      where q.room_id = r.id and q.position = r.current_position;
      select * into cur_nom from private.nominations n where n.id = cur.nomination_id;
      remaining_ms := greatest(0, remaining_ms
                       - least(private.elapsed_ms(cur), coalesce(cur_nom.duration_ms, avg_ms)));
      now_playing := jsonb_build_object(
        'position', cur.position,
        'song_id', cur_nom.apple_music_song_id,
        'title', cur_nom.title,
        'artist', cur_nom.artist,
        'artwork_url', cur_nom.artwork_url,
        'duration_ms', cur_nom.duration_ms,
        'elapsed_ms', private.elapsed_ms(cur),
        'is_running', cur.resumed_at is not null,
        'as_of', clock_timestamp());
    end if;

    if r.phase in ('reveal', 'finished') and jsonb_array_length(history) > 0 then
      last_reveal := history -> (jsonb_array_length(history) - 1);
    end if;
  end if;

  if r.winner_participant_id is not null then
    select jsonb_build_object('id', p.id, 'nickname', p.nickname) into winner
    from private.participants p where p.id = r.winner_participant_id;
  end if;

  if r.rematch_room_id is not null then
    select rr.code into rematch_code from private.rooms rr where rr.id = r.rematch_room_id;
  end if;

  insert into public.room_public_state as s (room_id, revision, state, updated_at)
  values (r.id, 1, '{}'::jsonb, now())
  on conflict (room_id) do update set revision = s.revision + 1, updated_at = now();

  update public.room_public_state s set state = jsonb_build_object(
      'room_id', r.id,
      'code', r.code,
      'status', r.status,
      'phase', r.phase,
      'song_quota', r.song_quota,
      'storefront', r.storefront,
      'host_participant_id', r.host_participant_id,
      'players', players,
      'total_tracks', total_tracks,
      'remaining_count', remaining_count,
      'remaining_ms', remaining_ms,
      'remaining_is_estimate', is_estimate,
      'now_playing', now_playing,
      'last_reveal', last_reveal,
      'history', history,
      'winner', winner,
      'rematch_code', rematch_code,
      'revision', s.revision)
  where s.room_id = r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client API (RPC). All SECURITY DEFINER, empty search_path, authenticated only.
-- ---------------------------------------------------------------------------

create or replace function public.create_room(p_nickname text, p_song_quota int)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  rid uuid := gen_random_uuid();
  pid uuid := gen_random_uuid();
  room_code text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  if p_song_quota not in (3, 4, 5) then
    raise exception 'invalid_quota' using errcode = 'P0001';
  end if;
  room_code := private.new_room_code();
  insert into private.rooms (id, code, host_participant_id, song_quota)
  values (rid, room_code, pid, p_song_quota);
  insert into private.participants (id, room_id, user_id, nickname, is_host)
  values (pid, rid, auth.uid(), private.clean_nickname(p_nickname), true);
  perform private.refresh_public_state(rid);
  return jsonb_build_object('room_id', rid, 'participant_id', pid, 'code', room_code, 'is_host', true);
end;
$$;

create or replace function public.join_room(p_code text, p_nickname text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r   private.rooms;
  me  private.participants;
  nick text := private.clean_nickname(p_nickname);
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  select * into r from private.rooms where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  select * into me from private.participants p where p.room_id = r.id and p.user_id = auth.uid();
  if found then
    if me.removed_at is not null then
      raise exception 'removed_from_room' using errcode = 'P0001';
    end if;
    -- Reconnect: same device session, same seat.
    return jsonb_build_object('room_id', r.id, 'participant_id', me.id, 'code', r.code,
                              'is_host', me.is_host);
  end if;

  if r.status <> 'lobby' then
    raise exception 'game_already_started' using errcode = 'P0001';
  end if;
  if (select count(*) from private.participants p
      where p.room_id = r.id and p.removed_at is null) >= 16 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.participants p
             where p.room_id = r.id and p.removed_at is null and lower(p.nickname) = lower(nick)) then
    raise exception 'nickname_taken' using errcode = 'P0001';
  end if;

  insert into private.participants (room_id, user_id, nickname)
  values (r.id, auth.uid(), nick) returning * into me;
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('room_id', r.id, 'participant_id', me.id, 'code', r.code, 'is_host', false);
end;
$$;

-- Who am I in this room (used after app restart).
create or replace function public.get_my_seat(p_room_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me private.participants := private.require_member(p_room_id);
begin
  return jsonb_build_object('room_id', me.room_id, 'participant_id', me.id,
                            'nickname', me.nickname, 'is_host', me.is_host);
end;
$$;

-- The caller's own nominations. Never anyone else's.
create or replace function public.my_nominations(p_room_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me private.participants := private.require_member(p_room_id);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', n.id, 'song_id', n.apple_music_song_id, 'title', n.title,
             'artist', n.artist, 'duration_ms', n.duration_ms, 'artwork_url', n.artwork_url)
           order by n.created_at, n.id)
    from private.nominations n where n.participant_id = me.id), '[]'::jsonb);
end;
$$;

-- Returns {"ok":true,...} or {"ok":false,"error":"already_selected"|"quota_full"}.
-- "already_selected" deliberately says nothing about who holds the song.
create or replace function public.add_nomination(
  p_room_id uuid, p_song_id text, p_title text, p_artist text,
  p_duration_ms int, p_artwork_url text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me   private.participants := private.require_member(p_room_id);
  r    private.rooms;
  cnt  int;
  nid  uuid;
begin
  -- Shared lock on the room serialises against lock_room (which takes FOR UPDATE).
  select * into r from private.rooms where id = p_room_id for share;
  if r.status <> 'lobby' then
    raise exception 'game_already_started' using errcode = 'P0001';
  end if;
  -- Row lock on the caller serialises their own concurrent adds (quota race).
  perform 1 from private.participants p where p.id = me.id for update;
  select count(*) into cnt from private.nominations n where n.participant_id = me.id;
  if cnt >= r.song_quota then
    return jsonb_build_object('ok', false, 'error', 'quota_full');
  end if;

  insert into private.nominations (room_id, participant_id, apple_music_song_id, title, artist,
                                   duration_ms, artwork_url)
  values (p_room_id, me.id, btrim(p_song_id), left(btrim(p_title), 300), left(btrim(p_artist), 300),
          case when p_duration_ms between 1000 and 3600000 then p_duration_ms end,
          nullif(left(btrim(coalesce(p_artwork_url, '')), 1000), ''))
  on conflict (room_id, apple_music_song_id) do nothing
  returning id into nid;

  if nid is null then
    return jsonb_build_object('ok', false, 'error', 'already_selected');
  end if;
  perform private.refresh_public_state(p_room_id);
  return jsonb_build_object('ok', true, 'id', nid, 'count', cnt + 1, 'quota', r.song_quota);
end;
$$;

create or replace function public.remove_nomination(p_room_id uuid, p_nomination_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me private.participants := private.require_member(p_room_id);
  r  private.rooms;
begin
  select * into r from private.rooms where id = p_room_id for share;
  if r.status <> 'lobby' then
    raise exception 'game_already_started' using errcode = 'P0001';
  end if;
  delete from private.nominations n where n.id = p_nomination_id and n.participant_id = me.id;
  if found then
    perform private.refresh_public_state(p_room_id);
  end if;
  -- Same response whether the id was someone else's or nonexistent.
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.remove_participant(p_room_id uuid, p_participant_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.status <> 'lobby' then
    raise exception 'game_already_started' using errcode = 'P0001';
  end if;
  if p_participant_id = host.id then
    raise exception 'cannot_remove_host' using errcode = 'P0001';
  end if;
  delete from private.nominations n where n.participant_id = p_participant_id and n.room_id = p_room_id;
  update private.participants set removed_at = now()
  where id = p_participant_id and room_id = p_room_id and removed_at is null;
  if not found then
    raise exception 'participant_not_found' using errcode = 'P0001';
  end if;
  perform private.refresh_public_state(p_room_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Lock the room: one CSPRNG Fisher-Yates shuffle, persisted once, never changed.
create or replace function public.lock_room(p_room_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host     private.participants := private.require_host(p_room_id);
  r        private.rooms;
  players  int;
  ids      uuid[];
  n        int;
  j        int;
  tmp      uuid;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.status <> 'lobby' then
    raise exception 'already_locked' using errcode = 'P0001';
  end if;
  select count(*) into players from private.participants p
  where p.room_id = r.id and p.removed_at is null;
  if players < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.participants p
             where p.room_id = r.id and p.removed_at is null
               and (select count(*) from private.nominations x where x.participant_id = p.id)
                   <> r.song_quota) then
    raise exception 'players_not_ready' using errcode = 'P0001';
  end if;

  select array_agg(x.id order by x.id) into ids
  from private.nominations x
  join private.participants p on p.id = x.participant_id
  where x.room_id = r.id and p.removed_at is null;

  n := array_length(ids, 1);
  for i in reverse n..2 loop
    j := private.random_below(i) + 1;   -- uniform in [1, i]
    tmp := ids[i]; ids[i] := ids[j]; ids[j] := tmp;
  end loop;

  insert into private.queue_entries (room_id, position, nomination_id)
  select r.id, t.ord::int, t.nid from unnest(ids) with ordinality as t(nid, ord);

  update private.rooms
     set status = 'playing', phase = 'ready', current_position = 1, locked_at = now()
   where id = r.id;
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('ok', true, 'total_tracks', n);
end;
$$;

-- Host: start (or recover) the current track. From 'reveal' this advances to the next
-- track first, so "Play next" is a single host confirmation. Returns the ONE song ID the
-- host device needs right now, plus elapsed time so a restarted host can resume in place.
create or replace function public.host_play(p_room_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
  e    private.queue_entries;
  nom  private.nominations;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.status <> 'playing' then
    raise exception 'not_playing' using errcode = 'P0001';
  end if;

  if r.phase = 'reveal' then
    r.current_position := r.current_position + 1;
    update private.rooms set current_position = r.current_position where id = r.id;
    r.phase := 'ready';
  end if;

  select * into e from private.queue_entries q
  where q.room_id = r.id and q.position = r.current_position for update;

  if r.phase = 'ready' then
    update private.queue_entries set status = 'playing', started_at = now(),
           resumed_at = clock_timestamp(), play_accum_ms = 0
     where room_id = r.id and position = e.position returning * into e;
    update private.rooms set phase = 'playing' where id = r.id;
  elsif r.phase = 'failed' then
    -- Retry from the start of the track.
    update private.queue_entries set resumed_at = clock_timestamp(), play_accum_ms = 0
     where room_id = r.id and position = e.position returning * into e;
    update private.rooms set phase = 'playing' where id = r.id;
  end if;
  -- 'playing' / 'paused': idempotent recovery, state unchanged.

  select * into nom from private.nominations where id = e.nomination_id;
  perform private.refresh_public_state(r.id);
  select phase into r.phase from private.rooms where id = r.id;
  return jsonb_build_object(
    'position', e.position,
    'song_id', nom.apple_music_song_id,
    'title', nom.title,
    'artist', nom.artist,
    'duration_ms', nom.duration_ms,
    'elapsed_ms', private.elapsed_ms(e),
    'phase', r.phase);
end;
$$;

create or replace function public.host_set_paused(p_room_id uuid, p_position int, p_paused boolean)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
  e    private.queue_entries;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.phase not in ('playing', 'paused') or r.current_position is distinct from p_position then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  select * into e from private.queue_entries q
  where q.room_id = r.id and q.position = p_position for update;
  if p_paused and e.resumed_at is not null then
    update private.queue_entries set play_accum_ms = private.elapsed_ms(e), resumed_at = null
     where room_id = r.id and position = p_position;
    update private.rooms set phase = 'paused' where id = r.id;
  elsif not p_paused and e.resumed_at is null then
    update private.queue_entries set resumed_at = clock_timestamp()
     where room_id = r.id and position = p_position;
    update private.rooms set phase = 'playing' where id = r.id;
  end if;
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Internal: finish the current entry (completed or unplayable), then reveal or finish.
create or replace function private.finish_current(r private.rooms, p_status text)
returns void
language plpgsql volatile set search_path = ''
as $$
declare
  last_pos int;
  owner    uuid;
begin
  update private.queue_entries
     set status = p_status, completed_at = now(),
         play_accum_ms = private.elapsed_ms(queue_entries), resumed_at = null
   where room_id = r.id and position = r.current_position;

  select max(position) into last_pos from private.queue_entries where room_id = r.id;
  if r.current_position >= last_pos then
    select n.participant_id into owner
    from private.queue_entries q join private.nominations n on n.id = q.nomination_id
    where q.room_id = r.id and q.position = last_pos;
    update private.rooms set status = 'finished', phase = 'finished',
           winner_participant_id = owner, finished_at = now()
     where id = r.id;
  else
    update private.rooms set phase = 'reveal' where id = r.id;
  end if;
end;
$$;

-- Host: the current track finished playing. Rejected if far less audio has played than
-- the track's length (no skipping in normal play). Idempotent for an already-finished
-- position so a retried network call is harmless.
create or replace function public.host_complete_track(p_room_id uuid, p_position int)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
  e    private.queue_entries;
  dur  int;
begin
  select * into r from private.rooms where id = p_room_id for update;
  select * into e from private.queue_entries q
  where q.room_id = r.id and q.position = p_position for update;
  if not found then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;
  if e.status in ('completed', 'unplayable') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if r.phase not in ('playing', 'paused') or r.current_position <> p_position then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  select duration_ms into dur from private.nominations where id = e.nomination_id;
  -- 10 s tolerance for clock/network jitter; unknown durations need at least 20 s.
  if private.elapsed_ms(e) < greatest(coalesce(dur, 30000) - 10000, 20000) then
    raise exception 'track_not_finished' using errcode = 'P0001';
  end if;
  perform private.finish_current(r, 'completed');
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Host: playback failed on the device. Everyone sees a neutral "sorting it out" state.
create or replace function public.host_report_failure(p_room_id uuid, p_position int)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
  e    private.queue_entries;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.phase not in ('playing', 'paused', 'failed') or r.current_position <> p_position then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  select * into e from private.queue_entries q
  where q.room_id = r.id and q.position = p_position for update;
  update private.queue_entries
     set failure_count = failure_count + 1, play_accum_ms = private.elapsed_ms(e), resumed_at = null
   where room_id = r.id and position = p_position;
  update private.rooms set phase = 'failed' where id = r.id;
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Host: after at least one failed attempt, mark the track unplayable. It is revealed and
-- counts as played for its owner; the locked order is untouched. (Rule pending approval.)
create or replace function public.host_mark_unplayable(p_room_id uuid, p_position int)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.phase <> 'failed' or r.current_position <> p_position then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  perform private.finish_current(r, 'unplayable');
  perform private.refresh_public_state(r.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Host: new lobby with the same settings. Other players see rematch_code and rejoin.
create or replace function public.create_rematch(p_room_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  host private.participants := private.require_host(p_room_id);
  r    private.rooms;
  res  jsonb;
begin
  select * into r from private.rooms where id = p_room_id for update;
  if r.status <> 'finished' then
    raise exception 'not_finished' using errcode = 'P0001';
  end if;
  if r.rematch_room_id is not null then
    return jsonb_build_object('room_id', r.rematch_room_id,
      'code', (select code from private.rooms where id = r.rematch_room_id), 'is_host', true,
      'participant_id', (select id from private.participants
                         where room_id = r.rematch_room_id and user_id = auth.uid()));
  end if;
  res := public.create_room(host.nickname, r.song_quota);
  update private.rooms set rematch_room_id = (res ->> 'room_id')::uuid where id = r.id;
  perform private.refresh_public_state(r.id);
  return res;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: clients may execute the API functions above and nothing else.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
begin
  -- Private helpers: nobody but the owner.
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- Public API: authenticated only.
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname in (
      'create_room', 'join_room', 'get_my_seat', 'my_nominations', 'add_nomination',
      'remove_nomination', 'remove_participant', 'lock_room', 'host_play',
      'host_set_paused', 'host_complete_track', 'host_report_failure',
      'host_mark_unplayable', 'create_rematch', 'is_room_member')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
