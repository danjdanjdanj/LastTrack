import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, setupLobby, fastForward, expectError } from './helpers.js';

after(() => pool.end());

test('rooms older than 48 hours are deleted with all their data; newer rooms stay', async () => {
  const old = await setupLobby(2, 3);
  await old.host.rpc('lock_room', { p_room_id: old.roomId });
  await old.host.rpc('host_play', { p_room_id: old.roomId });
  await fastForward(old.roomId);
  await old.host.rpc('host_complete_track', { p_room_id: old.roomId, p_position: 1 });
  const fresh = await setupLobby(2, 3);

  await pool.query("update private.rooms set created_at = now() - interval '49 hours' where id = $1", [old.roomId]);
  const { rows } = await pool.query('select private.purge_old_rooms() as n');
  assert.ok(rows[0].n >= 1);

  for (const t of ['rooms', 'participants', 'nominations', 'queue_entries']) {
    const col = t === 'rooms' ? 'id' : 'room_id';
    const r = await pool.query(`select count(*)::int c from private.${t} where ${col} = $1`, [old.roomId]);
    assert.equal(r.rows[0].c, 0, `${t} purged`);
  }
  assert.equal(await old.host.state(old.roomId), null, 'public state purged');
  await expectError(old.host.rpc('get_my_seat', { p_room_id: old.roomId }), 'not_a_member');

  const kept = await pool.query('select count(*)::int c from private.nominations where room_id = $1', [fresh.roomId]);
  assert.equal(kept.rows[0].c, 6, 'newer room untouched');
});
