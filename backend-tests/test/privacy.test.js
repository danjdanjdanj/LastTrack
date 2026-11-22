import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, newUser, asRole, callRpc, setupLobby, expectError, fastForward, song } from './helpers.js';

after(() => pool.end());

const API = [
  ['create_room', { p_nickname: 'x', p_song_quota: 3 }],
  ['join_room', { p_code: 'AAAAAA', p_nickname: 'x' }],
];

test('anon role cannot call any API function or read state', async () => {
  for (const [fn, args] of API) {
    await expectError(callRpc(null, fn, args), 'permission denied');
  }
  await expectError(asRole(null, 'select * from public.room_public_state'), 'permission denied');
});

test('authenticated clients cannot touch the private schema at all', async () => {
  const { roomId, host } = await setupLobby(2, 3);
  for (const t of ['rooms', 'participants', 'nominations', 'queue_entries']) {
    await expectError(host.query(`select * from private.${t}`), 'permission denied');
  }
  await expectError(host.query('select private.random_below(5)'), 'permission denied');
  await expectError(host.query("select private.refresh_public_state($1)", [roomId]), 'permission denied');
});

test('clients cannot write the public projection', async () => {
  const { roomId, host } = await setupLobby(2, 3);
  await expectError(host.query("update public.room_public_state set state='{}' where room_id=$1", [roomId]), 'permission denied');
  await expectError(host.query('delete from public.room_public_state'), 'permission denied');
  await expectError(host.query("insert into public.room_public_state(room_id,state) values (gen_random_uuid(),'{}')"), 'permission denied');
});

test('non-members see nothing and cannot act on a room', async () => {
  const { roomId, players } = await setupLobby(2, 3);
  const stranger = newUser();
  assert.equal(await stranger.state(roomId), null);
  const all = await stranger.query('select * from public.room_public_state');
  assert.equal(all.rowCount, 0, 'RLS hides every room the caller is not in');
  await expectError(stranger.rpc('my_nominations', { p_room_id: roomId }), 'not_a_member');
  await expectError(stranger.rpc('add_nomination', { p_room_id: roomId, ...song() }), 'not_a_member');
  await expectError(stranger.rpc('host_play', { p_room_id: roomId }), 'not_a_member');
  await expectError(stranger.rpc('get_my_seat', { p_room_id: roomId }), 'not_a_member');
  assert.ok(players.length === 2);
});

test('only the host can run host operations', async () => {
  const { roomId, host, players } = await setupLobby(3, 3);
  const p = players[1].user;
  await expectError(p.rpc('lock_room', { p_room_id: roomId }), 'host_only');
  await host.rpc('lock_room', { p_room_id: roomId });
  for (const [fn, extra] of [
    ['host_play', {}],
    ['host_set_paused', { p_position: 1, p_paused: true }],
    ['host_complete_track', { p_position: 1 }],
    ['host_report_failure', { p_position: 1 }],
    ['host_mark_unplayable', { p_position: 1 }],
    ['create_rematch', {}],
    ['remove_participant', { p_participant_id: host.id }],
  ]) {
    await expectError(p.rpc(fn, { p_room_id: roomId, ...extra }), 'host_only');
  }
});

test('my_nominations returns only the caller\'s own picks', async () => {
  const { roomId, players } = await setupLobby(3, 4);
  for (const p of players) {
    const mine = await p.user.rpc('my_nominations', { p_room_id: roomId });
    assert.deepEqual(mine.map((m) => m.song_id).sort(), p.songs.map((s) => s.p_song_id).sort());
  }
});

// The core privacy contract: walk a whole game and, after every transition, check what
// every participant (including the host) can read, field by field.
test('full game never exposes unplayed nominations, owners, order or per-player counts', async () => {
  const { roomId, host, players } = await setupLobby(4, 3);
  const ownerOf = new Map();
  for (const p of players) for (const s of p.songs) ownerOf.set(s.p_song_id, p.seat.participant_id);

  const TOP = ['room_id', 'code', 'status', 'phase', 'song_quota', 'storefront', 'host_participant_id',
    'players', 'total_tracks', 'remaining_count', 'remaining_ms', 'remaining_is_estimate',
    'now_playing', 'last_reveal', 'history', 'winner', 'rematch_code', 'revision'].sort();
  const PLAYER = ['id', 'nickname', 'is_host', 'submitted_count', 'status'].sort();
  const NOW = ['position', 'song_id', 'title', 'artist', 'artwork_url', 'duration_ms', 'elapsed_ms', 'is_running', 'as_of'].sort();

  async function checkAll(currentSongId) {
    for (const p of players) {
      const st = await p.user.state(roomId);
      assert.deepEqual(Object.keys(st).sort(), TOP, 'no unexpected top-level fields');
      for (const pl of st.players) {
        assert.deepEqual(Object.keys(pl).sort(), PLAYER);
        if (st.status !== 'lobby') assert.equal(pl.submitted_count, null, 'no per-player counts in play');
      }
      if (st.now_playing) {
        assert.deepEqual(Object.keys(st.now_playing).sort(), NOW, 'now playing carries no owner');
      }
      const revealed = new Set(st.history.map((h) => h.song_id));
      const json = JSON.stringify(st);
      for (const [songId] of ownerOf) {
        if (revealed.has(songId) || songId === currentSongId) continue;
        assert.ok(!json.includes(songId), `unplayed song ${songId} leaked to ${p.seat.participant_id}`);
        assert.ok(!json.includes(`Secret Title ${songId}`), 'unplayed title leaked');
      }
      for (const h of st.history) assert.equal(h.owner_id, ownerOf.get(h.song_id), 'correct owner revealed');
    }
  }

  await checkAll(null);
  await host.rpc('lock_room', { p_room_id: roomId });
  await checkAll(null);

  const order = [];
  for (let i = 1; i <= 12; i++) {
    const play = await host.rpc('host_play', { p_room_id: roomId });
    assert.deepEqual(Object.keys(play).sort(),
      ['artist', 'duration_ms', 'elapsed_ms', 'phase', 'position', 'song_id', 'title'],
      'host receives one track at a time, without its owner');
    assert.equal(play.position, i);
    order.push(play.song_id);
    await checkAll(play.song_id);

    const st = await host.state(roomId);
    assert.equal(st.remaining_count, 12 - i + 1, 'remaining count includes the playing track');

    await fastForward(roomId);
    await host.rpc('host_complete_track', { p_room_id: roomId, p_position: i });
    await checkAll(null);
  }
  assert.equal(new Set(order).size, 12, 'every nomination played exactly once');
});

test('per-player status only changes when a final track is revealed', async () => {
  const { roomId, host, players } = await setupLobby(3, 3);
  await host.rpc('lock_room', { p_room_id: roomId });
  const q = await pool.query(
    `select q.position, n.participant_id from private.queue_entries q
       join private.nominations n on n.id = q.nomination_id where q.room_id=$1 order by q.position`, [roomId]);
  const lastPos = new Map();
  for (const r of q.rows) lastPos.set(r.participant_id, r.position);
  const winnerId = q.rows.at(-1).participant_id;

  for (const { position } of q.rows) {
    await host.rpc('host_play', { p_room_id: roomId });
    let st = await players[1].user.state(roomId);
    for (const pl of st.players) {
      const shouldBeOut = lastPos.get(pl.id) < position;
      assert.equal(pl.status, shouldBeOut ? 'out' : 'in', `during track ${position}`);
    }
    await fastForward(roomId);
    await host.rpc('host_complete_track', { p_room_id: roomId, p_position: position });
    st = await players[1].user.state(roomId);
    for (const pl of st.players) {
      const expected = st.status === 'finished' && pl.id === winnerId ? 'winner'
        : lastPos.get(pl.id) <= position ? 'out' : 'in';
      assert.equal(pl.status, expected, `after track ${position}`);
    }
    if (st.status !== 'finished') {
      assert.equal(st.last_reveal.position, position);
      assert.equal(st.last_reveal.owner_eliminated, lastPos.get(st.last_reveal.owner_id) === position);
    }
  }
  const final = await host.state(roomId);
  assert.equal(final.status, 'finished');
  assert.equal(final.winner.id, winnerId, 'owner of the final track wins');
  assert.equal(final.history.length, 9);
  assert.equal(final.remaining_count, 0);
});
