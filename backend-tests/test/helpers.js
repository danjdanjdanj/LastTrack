import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 40 });

let songCounter = 100000;
export const nextSongId = () => String(++songCounter);

// Run SQL exactly as a Supabase client would: role `authenticated` with a JWT subject,
// or role `anon` when uid is null.
export async function asRole(uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (uid) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function callRpc(uid, fn, args = {}) {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const r = await asRole(uid, `select public.${fn}(${named}) as r`, keys.map((k) => args[k]));
  return r.rows[0].r;
}

export function newUser() {
  const id = randomUUID();
  return {
    id,
    rpc: (fn, args) => callRpc(id, fn, args),
    query: (sql, params) => asRole(id, sql, params),
    async state(roomId) {
      const r = await asRole(id, 'select state from public.room_public_state where room_id = $1', [roomId]);
      return r.rows[0]?.state ?? null;
    },
  };
}

// Superuser-only test hook: pretend the current track has played for a long time.
export async function fastForward(roomId, ms = 10_000_000) {
  await pool.query(
    `update private.queue_entries set play_accum_ms = $2
      where room_id = $1 and status = 'playing'`, [roomId, ms]);
}

export function song(overrides = {}) {
  const id = nextSongId();
  return {
    p_song_id: id,
    p_title: `Secret Title ${id}`,
    p_artist: `Hidden Artist ${id}`,
    p_duration_ms: 180000,
    p_artwork_url: `https://example.invalid/art/${id}.jpg`,
    ...overrides,
  };
}

// Host + (n-1) players, every player nominates `quota` unique songs and submits.
export async function setupLobby(nPlayers = 4, quota = 3, { submit = true } = {}) {
  const host = newUser();
  const created = await host.rpc('create_room', { p_nickname: 'Host', p_song_quota: quota });
  const roomId = created.room_id;
  const players = [{ user: host, seat: created, songs: [] }];
  for (let i = 1; i < nPlayers; i++) {
    const u = newUser();
    const seat = await u.rpc('join_room', { p_code: created.code, p_nickname: `Player${i}` });
    players.push({ user: u, seat, songs: [] });
  }
  for (const p of players) {
    for (let k = 0; k < quota; k++) {
      const s = song();
      const res = await p.user.rpc('add_nomination', { p_room_id: roomId, ...s });
      if (!res.ok) throw new Error(`setup add failed: ${JSON.stringify(res)}`);
      p.songs.push(s);
    }
    if (submit) await p.user.rpc('set_ready', { p_room_id: roomId, p_ready: true });
  }
  return { roomId, code: created.code, host, players };
}

export async function expectError(promise, message) {
  try {
    await promise;
  } catch (e) {
    if (message && !String(e.message).includes(message)) {
      throw new Error(`expected error containing "${message}", got "${e.message}"`);
    }
    return e;
  }
  throw new Error(`expected error${message ? ` "${message}"` : ''} but call succeeded`);
}
