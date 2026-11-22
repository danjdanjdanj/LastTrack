import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, newUser, song, setupLobby, expectError } from './helpers.js';

after(() => pool.end());

test('create and join without accounts; nicknames unique per room; reconnect keeps seat', async () => {
  const host = newUser();
  const room = await host.rpc('create_room', { p_nickname: '  Dana  ', p_song_quota: 4 });
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(room.is_host, true);

  const a = newUser();
  const seat = await a.rpc('join_room', { p_code: room.code.toLowerCase(), p_nickname: 'Alex' });
  assert.equal(seat.room_id, room.room_id);
  assert.equal(seat.is_host, false);

  await expectError(newUser().rpc('join_room', { p_code: room.code, p_nickname: 'ALEX' }), 'nickname_taken');
  await expectError(newUser().rpc('join_room', { p_code: 'ZZZZZZ', p_nickname: 'X' }), 'room_not_found');
  await expectError(newUser().rpc('join_room', { p_code: room.code, p_nickname: '   ' }), 'invalid_nickname');

  const again = await a.rpc('join_room', { p_code: room.code, p_nickname: 'Whatever' });
  assert.equal(again.participant_id, seat.participant_id, 'same device session rejoins same seat');

  const st = await host.state(room.room_id);
  assert.deepEqual(st.players.map((p) => p.nickname), ['Dana', 'Alex']);
  assert.equal(st.song_quota, 4);
  assert.equal(st.storefront, 'au');
  assert.equal(st.total_tracks, 8);
});

test('quota of 3, 4 or 5 only', async () => {
  const u = newUser();
  for (const q of [2, 6, 0]) {
    await expectError(u.rpc('create_room', { p_nickname: 'H', p_song_quota: q }), 'invalid_quota');
  }
});

test('own quota enforced; ready requires exactly the quota; editing locked while ready', async () => {
  const { roomId, players } = await setupLobby(2, 3, { submit: false });
  const me = players[1].user;
  const full = await me.rpc('add_nomination', { p_room_id: roomId, ...song() });
  assert.deepEqual(full, { ok: false, error: 'quota_full' });

  const mine = await me.rpc('my_nominations', { p_room_id: roomId });
  assert.equal(mine.length, 3);
  await me.rpc('remove_nomination', { p_room_id: roomId, p_nomination_id: mine[0].id });
  await expectError(me.rpc('set_ready', { p_room_id: roomId, p_ready: true }), 'quota_not_met');
  await me.rpc('add_nomination', { p_room_id: roomId, ...song() });
  await me.rpc('set_ready', { p_room_id: roomId, p_ready: true });
  await expectError(me.rpc('add_nomination', { p_room_id: roomId, ...song() }), 'already_submitted');
  await me.rpc('set_ready', { p_room_id: roomId, p_ready: false });
  const st = await me.state(roomId);
  assert.equal(st.players[1].ready, false);
});

test('duplicate catalogue IDs rejected with a neutral message', async () => {
  const { roomId, code, players } = await setupLobby(3, 3, { submit: false });
  const taken = players[0].songs[0];
  const late = newUser();
  await late.rpc('join_room', { p_code: code, p_nickname: 'Late' });
  const res = await late.rpc('add_nomination', { p_room_id: roomId, ...taken, p_title: 'x' });
  assert.deepEqual(res, { ok: false, error: 'already_selected' });
  assert.ok(!JSON.stringify(res).includes('Host'), 'does not identify the original chooser');
});

test('duplicate rejected reliably under simultaneous submissions', async () => {
  for (let round = 0; round < 5; round++) {
    const host = newUser();
    const room = await host.rpc('create_room', { p_nickname: 'H', p_song_quota: 5 });
    const users = [host];
    for (let i = 0; i < 11; i++) {
      const u = newUser();
      await u.rpc('join_room', { p_code: room.code, p_nickname: `P${i}` });
      users.push(u);
    }
    const s = song();
    const results = await Promise.all(users.map((u) => u.rpc('add_nomination', { p_room_id: room.room_id, ...s })));
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one winner of the race');
    assert.equal(results.filter((r) => r.error === 'already_selected').length, 11);
  }
});

test('one player cannot exceed quota with parallel adds', async () => {
  const host = newUser();
  const room = await host.rpc('create_room', { p_nickname: 'H', p_song_quota: 3 });
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    host.rpc('add_nomination', { p_room_id: room.room_id, ...song() })));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal((await host.rpc('my_nominations', { p_room_id: room.room_id })).length, 3);
});

test('cannot remove someone else\'s nomination', async () => {
  const { roomId, players } = await setupLobby(2, 3, { submit: false });
  const theirs = await players[0].user.rpc('my_nominations', { p_room_id: roomId });
  await players[1].user.rpc('remove_nomination', { p_room_id: roomId, p_nomination_id: theirs[0].id });
  assert.equal((await players[0].user.rpc('my_nominations', { p_room_id: roomId })).length, 3);
});

test('lock rules: host only, everyone ready, at least 2 players, once only', async () => {
  const solo = newUser();
  const r1 = await solo.rpc('create_room', { p_nickname: 'H', p_song_quota: 3 });
  await expectError(solo.rpc('lock_room', { p_room_id: r1.room_id }), 'not_enough_players');

  const { roomId, host, players, code } = await setupLobby(3, 3, { submit: false });
  await expectError(players[1].user.rpc('lock_room', { p_room_id: roomId }), 'host_only');
  for (const p of players.slice(0, 2)) await p.user.rpc('set_ready', { p_room_id: roomId, p_ready: true });
  await expectError(host.rpc('lock_room', { p_room_id: roomId }), 'players_not_ready');

  // Host removes the inactive player, then can lock.
  await host.rpc('remove_participant', { p_room_id: roomId, p_participant_id: players[2].seat.participant_id });
  const locked = await host.rpc('lock_room', { p_room_id: roomId });
  assert.equal(locked.total_tracks, 6);
  await expectError(host.rpc('lock_room', { p_room_id: roomId }), 'already_locked');

  await expectError(newUser().rpc('join_room', { p_code: code, p_nickname: 'Late' }), 'game_already_started');
  await expectError(players[1].user.rpc('set_ready', { p_room_id: roomId, p_ready: false }), 'game_already_started');
  await expectError(players[1].user.rpc('add_nomination', { p_room_id: roomId, ...song() }), 'game_already_started');
  await expectError(host.rpc('remove_participant', { p_room_id: roomId, p_participant_id: players[1].seat.participant_id }), 'game_already_started');

  // Removed player cannot rejoin or read the room.
  await expectError(players[2].user.rpc('join_room', { p_code: code, p_nickname: 'Back' }), 'removed_from_room');
  assert.equal(await players[2].user.state(roomId), null);
});

test('locked queue is a permutation of all nominations and cannot change', async () => {
  const { roomId, host } = await setupLobby(4, 5);
  await host.rpc('lock_room', { p_room_id: roomId });
  const q1 = await pool.query('select position, nomination_id from private.queue_entries where room_id=$1 order by position', [roomId]);
  assert.equal(q1.rowCount, 20);
  assert.deepEqual(q1.rows.map((r) => r.position), Array.from({ length: 20 }, (_, i) => i + 1));
  const n = await pool.query('select count(distinct nomination_id) c from private.queue_entries where room_id=$1', [roomId]);
  assert.equal(Number(n.rows[0].c), 20);
  await expectError(host.rpc('lock_room', { p_room_id: roomId }), 'already_locked');
  const q2 = await pool.query('select position, nomination_id from private.queue_entries where room_id=$1 order by position', [roomId]);
  assert.deepEqual(q2.rows, q1.rows);
});
