import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, newUser, setupLobby, expectError, fastForward, song } from './helpers.js';

after(() => pool.end());

async function lockedGame(n = 2, quota = 3) {
  const g = await setupLobby(n, quota);
  await g.host.rpc('lock_room', { p_room_id: g.roomId });
  return g;
}

test('no skipping: completing a track early is rejected', async () => {
  const { roomId, host } = await lockedGame();
  await host.rpc('host_play', { p_room_id: roomId });
  await expectError(host.rpc('host_complete_track', { p_room_id: roomId, p_position: 1 }), 'track_not_finished');
  await fastForward(roomId, 175000); // within 10 s tolerance of a 180 s track
  await host.rpc('host_complete_track', { p_room_id: roomId, p_position: 1 });
  // Retried network call is harmless.
  const again = await host.rpc('host_complete_track', { p_room_id: roomId, p_position: 1 });
  assert.equal(again.already, true);
  // Cannot complete a future track.
  await expectError(host.rpc('host_complete_track', { p_room_id: roomId, p_position: 3 }), 'invalid_state');
});

test('host restart recovers the same track and elapsed time; no replay', async () => {
  const { roomId, host } = await lockedGame();
  const first = await host.rpc('host_play', { p_room_id: roomId });
  await fastForward(roomId, 60000);
  const recovered = await host.rpc('host_play', { p_room_id: roomId });
  assert.equal(recovered.song_id, first.song_id);
  assert.equal(recovered.position, 1);
  assert.ok(recovered.elapsed_ms >= 60000, 'resume point returned');
  await fastForward(roomId);
  await host.rpc('host_complete_track', { p_room_id: roomId, p_position: 1 });
  const st = await host.state(roomId);
  assert.equal(st.phase, 'reveal');
  // From reveal, play advances; the finished track is never served again.
  const second = await host.rpc('host_play', { p_room_id: roomId });
  assert.equal(second.position, 2);
  assert.notEqual(second.song_id, first.song_id);
});

test('pause and resume adjust the remaining-time estimate', async () => {
  const { roomId, host, players } = await lockedGame(2, 3);
  await host.rpc('host_play', { p_room_id: roomId });
  await fastForward(roomId, 0);
  let st = await players[1].user.state(roomId);
  assert.equal(st.now_playing.is_running, true);
  assert.ok(st.remaining_ms <= 6 * 180000 && st.remaining_ms > 5 * 180000);

  await host.rpc('host_set_paused', { p_room_id: roomId, p_position: 1, p_paused: true });
  st = await players[1].user.state(roomId);
  assert.equal(st.phase, 'paused');
  assert.equal(st.now_playing.is_running, false);
  const frozen = st.remaining_ms;
  await new Promise((r) => setTimeout(r, 300));
  await host.rpc('host_set_paused', { p_room_id: roomId, p_position: 1, p_paused: true }); // idempotent
  st = await players[1].user.state(roomId);
  assert.equal(st.remaining_ms, frozen, 'paused time does not count');

  await host.rpc('host_set_paused', { p_room_id: roomId, p_position: 1, p_paused: false });
  st = await players[1].user.state(roomId);
  assert.equal(st.phase, 'playing');
});

test('missing durations fall back to an estimate and are flagged', async () => {
  const host = newUser();
  const room = await host.rpc('create_room', { p_nickname: 'H', p_song_quota: 3 });
  const p = newUser();
  await p.rpc('join_room', { p_code: room.code, p_nickname: 'P' });
  for (const u of [host, p]) {
    for (let i = 0; i < 3; i++) {
      await u.rpc('add_nomination', { p_room_id: room.room_id, ...song({ p_duration_ms: u === p && i === 0 ? null : 200000 }) });
    }
    await u.rpc('set_ready', { p_room_id: room.room_id, p_ready: true });
  }
  await host.rpc('lock_room', { p_room_id: room.room_id });
  const st = await host.state(room.room_id);
  assert.equal(st.remaining_is_estimate, true);
  assert.equal(st.remaining_ms, 6 * 200000, 'missing duration replaced by average of known');
});

test('playback failure: neutral public state, retry, then mark unplayable keeps order', async () => {
  const { roomId, host, players } = await lockedGame(2, 3);
  const t1 = await host.rpc('host_play', { p_room_id: roomId });
  await expectError(host.rpc('host_mark_unplayable', { p_room_id: roomId, p_position: 1 }), 'invalid_state');
  await host.rpc('host_report_failure', { p_room_id: roomId, p_position: 1 });
  let st = await players[1].user.state(roomId);
  assert.equal(st.phase, 'failed');
  assert.equal(st.history.length, 0, 'failure reveals nothing');

  const retry = await host.rpc('host_play', { p_room_id: roomId });
  assert.equal(retry.song_id, t1.song_id);
  assert.equal(retry.elapsed_ms < 1000, true, 'retry restarts the track');
  await host.rpc('host_report_failure', { p_room_id: roomId, p_position: 1 });
  await host.rpc('host_mark_unplayable', { p_room_id: roomId, p_position: 1 });
  st = await players[1].user.state(roomId);
  assert.equal(st.phase, 'reveal');
  assert.equal(st.history[0].outcome, 'unplayable');
  assert.equal(st.history[0].song_id, t1.song_id);
  assert.equal(st.remaining_count, 5);
  const t2 = await host.rpc('host_play', { p_room_id: roomId });
  assert.equal(t2.position, 2);
});

test('rematch creates a new lobby that existing players can join', async () => {
  const { roomId, host, players } = await lockedGame(2, 3);
  await expectError(host.rpc('create_rematch', { p_room_id: roomId }), 'not_finished');
  for (let i = 1; i <= 6; i++) {
    await host.rpc('host_play', { p_room_id: roomId });
    await fastForward(roomId);
    await host.rpc('host_complete_track', { p_room_id: roomId, p_position: i });
  }
  const re = await host.rpc('create_rematch', { p_room_id: roomId });
  const again = await host.rpc('create_rematch', { p_room_id: roomId });
  assert.equal(again.room_id, re.room_id, 'idempotent');
  const st = await players[1].user.state(roomId);
  assert.equal(st.rematch_code, re.code);
  const seat = await players[1].user.rpc('join_room', { p_code: st.rematch_code, p_nickname: 'Player1' });
  const lobby = await players[1].user.state(seat.room_id);
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.players.length, 2);
});

test('shuffle source is unbiased: random_below passes a chi-square check', async () => {
  const n = 7, samples = 70000;
  const r = await pool.query(
    'select v, count(*)::int c from (select private.random_below($1) v from generate_series(1,$2)) s group by v order by v',
    [n, samples]);
  assert.equal(r.rowCount, n);
  const expected = samples / n;
  const chi = r.rows.reduce((a, { c }) => a + (c - expected) ** 2 / expected, 0);
  assert.ok(chi < 22.46, `chi-square ${chi.toFixed(2)} exceeds p=0.001 critical value for df=6`);
});

test('first-position owner is uniform across many locked rooms', async () => {
  // 4 players x 3 songs; each player should own position 1 about a quarter of the time.
  const counts = [0, 0, 0, 0];
  const trials = 120;
  for (let t = 0; t < trials; t++) {
    const { roomId, host, players } = await setupLobby(4, 3);
    await host.rpc('lock_room', { p_room_id: roomId });
    const first = await host.rpc('host_play', { p_room_id: roomId });
    const idx = players.findIndex((p) => p.songs.some((s) => s.p_song_id === first.song_id));
    counts[idx]++;
  }
  const expected = trials / 4;
  const chi = counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
  assert.ok(chi < 16.27, `chi-square ${chi.toFixed(2)} (counts ${counts}) exceeds p=0.001 for df=3`);
});
