import { MockCatalog, AppleMusicProxyCatalog } from './catalog.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const cfg = window.LAST_TRACK_CONFIG;
const params = new URLSearchParams(location.search);
// `?seat=` lets one browser hold several independent player sessions (testing only).
const seatKey = (params.get('seat') || 'main').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'main';
const TEST_HOST = window.LT_TEST_HOST === true;

const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { storageKey: `lt-auth-${TEST_HOST ? 'host-' : ''}${seatKey}`, persistSession: true, autoRefreshToken: true },
});
const catalog = cfg.catalog === 'apple' ? new AppleMusicProxyCatalog(sb) : new MockCatalog();

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const ui = {
  roomId: null,
  seat: null,          // { participant_id, nickname, is_host }
  state: null,         // public room state
  receivedAt: 0,       // performance.now() when state arrived (avoids client/server clock skew)
  mine: [],            // own nominations
  results: [],
  taken: new Set(),    // song IDs the server said are already selected
  viewKey: null,
  channel: null,
  busy: false,
  completing: false,
};

const ERRORS = {
  already_selected: 'Already selected. Pick another song.',
  quota_full: "You've picked all your songs. Remove one to swap it.",
  room_not_found: 'No game found with that code.',
  nickname_taken: 'That nickname is already taken in this game.',
  invalid_nickname: 'Enter a nickname of up to 20 characters.',
  game_already_started: 'This game has already started.',
  removed_from_room: 'You were removed from this game.',
  players_not_ready: 'Everyone needs to pick all their songs first.',
  not_enough_players: 'You need at least 2 players.',
  room_full: 'This game is full.',
  search_failed: 'Search is not working right now. Try again.',
  not_a_member: 'You are not in this game.',
};
const friendly = (e) => ERRORS[e?.message] || ERRORS[e] || 'Something went wrong. Try again.';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(`lt-${seatKey}-${TEST_HOST ? 'h' : 'p'}-${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`lt-${seatKey}-${TEST_HOST ? 'h' : 'p'}-${k}`, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(`lt-${seatKey}-${TEST_HOST ? 'h' : 'p'}-${k}`); } catch { /* ignore */ } },
};

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtLeft(ms) {
  if (ms <= 0) return '0 min';
  if (ms < 60000) return '<1 min';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function initials(s) {
  return esc(String(s || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
}
function artwork(url, title, big = false) {
  const cls = big ? 'art big' : 'art';
  return url ? `<img class="${cls}" src="${esc(url)}" alt="">` : `<div class="${cls}" aria-hidden="true">${initials(title)}</div>`;
}

// Elapsed time of the current track, advanced locally while it is running.
function liveElapsed() {
  const np = ui.state?.now_playing;
  if (!np) return 0;
  return np.elapsed_ms + (np.is_running ? performance.now() - ui.receivedAt : 0);
}
function liveRemaining() {
  const st = ui.state;
  if (!st) return 0;
  const running = st.now_playing?.is_running;
  return Math.max(0, st.remaining_ms - (running ? performance.now() - ui.receivedAt : 0));
}

// ---------------------------------------------------------------------------
// Session and room lifecycle
// ---------------------------------------------------------------------------

async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) throw error;
  }
}

async function enterRoom(seat) {
  ui.roomId = seat.room_id;
  ui.seat = seat;
  ui.state = null;
  ui.mine = [];
  ui.taken.clear();
  store.set('room', seat.room_id);
  store.set('nickname', seat.nickname || store.get('nickname') || '');
  if (ui.channel) sb.removeChannel(ui.channel);
  ui.channel = null;
  if (cfg.realtime !== false) ui.channel = sb.channel(`room-${seat.room_id}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'room_public_state', filter: `room_id=eq.${seat.room_id}` },
      (payload) => { if (payload.new?.state) applyState(payload.new.state); })
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh(); });
  await refresh();
  await loadMine();
}

function leaveRoom() {
  if (ui.channel) sb.removeChannel(ui.channel);
  ui.channel = null;
  ui.roomId = null;
  ui.seat = null;
  ui.state = null;
  store.del('room');
  render();
}

async function refresh() {
  if (!ui.roomId) return;
  const { data, error } = await sb.from('room_public_state').select('state').eq('room_id', ui.roomId).maybeSingle();
  if (error) return; // transient; realtime or the next poll will catch up
  if (!data) { ui.removed = true; render(); return; }
  applyState(data.state, true);
}

function applyState(st, force = false) {
  if (st.room_id !== ui.roomId) return;
  if (!force && ui.state && st.revision < ui.state.revision) return;
  ui.state = st;
  ui.receivedAt = performance.now();
  ui.removed = false;
  render();
}

async function loadMine() {
  if (!ui.roomId) return;
  try {
    ui.mine = await rpc('my_nominations', { p_room_id: ui.roomId });
  } catch (e) {
    if (e.message === 'not_a_member') { ui.removed = true; }
  }
  render();
}

// Recover after backgrounding or a network drop.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
// Polling is the safety net behind Realtime (missed events, sleeping phones).
setInterval(refresh, cfg.pollMs || 10000);

// ---------------------------------------------------------------------------
// Views. Each view has a static shell plus an update() that only touches
// sub-containers, so typing in the search box survives live updates.
// ---------------------------------------------------------------------------

const views = {};

views.join = {
  shell: () => `
    <p class="brand">Last Track</p>
    <h1>Join the game</h1>
    <p class="muted">Everyone picks the music. Nobody controls the playlist. Last track wins.</p>
    <form id="joinForm" class="card" autocomplete="off">
      <label for="code">Game code</label>
      <input id="code" type="text" inputmode="text" autocapitalize="characters" maxlength="6"
             value="${esc((params.get('code') || '').toUpperCase())}" placeholder="ABC234" required>
      <label for="nick">Your nickname</label>
      <input id="nick" type="text" maxlength="20" value="${esc(store.get('nickname') || '')}" placeholder="e.g. Tim" required>
      <button class="primary block" type="submit">Join</button>
    </form>`,
};

views.create = {
  shell: () => `
    <p class="brand">Last Track · test host</p>
    <h1>Host a game</h1>
    <p class="muted small">Browser test host with mock playback (no audio). The real host is the iPhone app.</p>
    <form id="createForm" class="card" autocomplete="off">
      <label for="nick">Your nickname</label>
      <input id="nick" type="text" maxlength="20" value="${esc(store.get('nickname') || '')}" required>
      <label>Songs per player</label>
      <div class="row" role="radiogroup">
        ${[3, 4, 5].map((n) => `<label class="row" style="margin:0;font-weight:500"><input type="radio" name="quota" value="${n}" ${n === 5 ? 'checked' : ''}> ${n}</label>`).join('')}
      </div>
      <button class="primary block" type="submit">Create game</button>
    </form>`,
};

views.loading = { shell: () => '<p class="muted center">Connecting…</p>' };

views.removed = {
  shell: () => `
    <p class="brand">Last Track</p>
    <h1>You're not in this game</h1>
    <p class="muted">You may have been removed by the host.</p>
    <button class="block" data-action="leave">Join another game</button>`,
};

function shareUrl(code) {
  const base = location.href.replace(/host\.html.*$/, 'index.html').replace(/\?.*$/, '');
  return `${base}?code=${encodeURIComponent(code)}`;
}

views.lobby = {
  shell: () => {
    const st = ui.state;
    return `
    <p class="brand">Last Track${TEST_HOST ? ' · test host' : ''}</p>
    <div class="row">
      <div class="grow"><h1>Pick your songs</h1><p class="muted">Game code <b>${esc(st.code)}</b></p></div>
      <div class="counter" id="myCount" aria-label="Your songs picked"></div>
    </div>
    ${TEST_HOST ? `<div class="card"><p class="small muted">Players join at</p><p class="small ellipsis"><a id="shareLink" href="${esc(shareUrl(st.code))}" target="_blank" rel="noopener">${esc(shareUrl(st.code))}</a></p><p class="code">${esc(st.code)}</p></div>` : ''}
    <p class="muted small">Your picks are secret. Nobody else can see them, not even the host.</p>
    <div class="card">
      <label for="search">Search songs</label>
      <input id="search" type="search" placeholder="Song or artist" autocomplete="off" enterkeyhint="search">
      <p class="muted small">${esc(catalog.label)}</p>
      <ul class="list" id="results"></ul>
    </div>
    <h2>Your picks</h2>
    <div class="card"><ul class="list" id="mine"></ul></div>
    <h2>Players</h2>
    <div class="card"><ul class="list" id="players"></ul></div>
    ${ui.seat.is_host ? '<button id="go" class="primary block go" data-action="go">GO!</button><p id="goHint" class="muted small center"></p>' : '<p id="waitHint" class="muted center"></p>'}`;
  },
  update: () => {
    const st = ui.state;
    const quota = st.song_quota;
    const full = ui.mine.length >= quota;
    $('myCount').textContent = `${ui.mine.length}/${quota}`;

    const mineIds = new Set(ui.mine.map((m) => m.song_id));
    $('results').innerHTML = ui.results.map((s) => {
      const isMine = mineIds.has(s.id);
      const taken = ui.taken.has(s.id);
      const label = isMine ? 'Added' : taken ? 'Taken' : 'Add';
      return `<li class="row">
        ${artwork(s.artworkUrl, s.title)}
        <div class="grow"><div class="ellipsis"><b>${esc(s.title)}</b></div><div class="muted small ellipsis">${esc(s.artist)}${s.durationMs ? ` · ${fmtClock(s.durationMs)}` : ''}</div></div>
        <button class="small ${isMine || taken ? '' : 'primary'}" data-action="add" data-id="${esc(s.id)}" ${isMine || taken || full ? 'disabled' : ''}>${label}</button>
      </li>`;
    }).join('');

    $('mine').innerHTML = ui.mine.length ? ui.mine.map((m) => `<li class="row">
        ${artwork(m.artwork_url, m.title)}
        <div class="grow"><div class="ellipsis"><b>${esc(m.title)}</b></div><div class="muted small ellipsis">${esc(m.artist)}</div></div>
        <button class="small" data-action="remove" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.title)}">Remove</button>
      </li>`).join('') : `<li class="muted">Search above and add ${quota} songs.</li>`;

    $('players').innerHTML = st.players.map((p) => {
      const done = p.submitted_count >= quota;
      return `<li class="row">
        <div class="grow"><b>${esc(p.nickname)}</b>${p.is_host ? ' <span class="muted small">host</span>' : ''}</div>
        <span class="pill ${done ? 'ok' : ''}">${p.submitted_count}/${quota}${done ? ' ✓' : ''}</span>
        ${ui.seat.is_host && !p.is_host ? `<button class="small" data-action="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.nickname)}">Remove</button>` : ''}
      </li>`;
    }).join('');

    const everyoneFull = st.players.length >= 2 && st.players.every((p) => p.submitted_count >= quota);
    if (ui.seat.is_host) {
      $('go').disabled = !everyoneFull || ui.busy;
      const waiting = st.players.filter((p) => p.submitted_count < quota).map((p) => p.nickname);
      $('goHint').textContent = st.players.length < 2 ? 'Waiting for players to join.'
        : waiting.length ? `Waiting for ${waiting.join(', ')}.` : 'Everyone is ready. Press GO to shuffle and start.';
    } else {
      $('waitHint').textContent = full ? "You're all set. You can still swap songs until the host presses GO."
        : `Pick ${quota - ui.mine.length} more.`;
    }
  },
};

function playersChips(st) {
  return st.players.map((p) => {
    const cls = p.status === 'winner' ? 'win' : p.status === 'out' ? 'out' : 'in';
    const label = p.status === 'winner' ? 'winner' : p.status === 'out' ? 'out' : 'in';
    return `<span class="pill ${cls}" title="${label}">${esc(p.nickname)} · ${label.toUpperCase()}</span>`;
  }).join('');
}

function historyItems(list) {
  return list.map((h) => `<li class="row">
      ${artwork(h.artwork_url, h.title)}
      <div class="grow">
        <div class="ellipsis"><b>${esc(h.title)}</b>${h.outcome === 'unplayable' ? ' <span class="muted small">(couldn\'t play)</span>' : ''}</div>
        <div class="muted small ellipsis">${esc(h.artist)} · picked by <b>${esc(h.owner_nickname)}</b></div>
      </div>
      <span class="muted small">#${h.position}</span>
    </li>`).join('');
}

views.game = {
  shell: () => `
    <p class="brand">Last Track${TEST_HOST ? ' · test host' : ''}</p>
    <div id="stage"></div>
    <div id="hostControls"></div>
    <div class="stats">
      <div class="stat"><span class="muted small">Tracks left</span><b id="left"></b></div>
      <div class="stat"><span class="muted small">Time left</span><b id="timeLeft"></b></div>
    </div>
    <h2>Players</h2>
    <div class="chips" id="chips"></div>
    <h2>Played so far</h2>
    <div class="card"><ul class="list" id="history"></ul></div>`,
  update: () => {
    const st = ui.state;
    const np = st.now_playing;
    let stage = '';
    if (st.phase === 'ready') {
      stage = '<div class="card reveal"><p class="muted">Shuffled and locked.</p><p class="who">Get ready</p><p class="muted">The host is starting the first song.</p></div>';
    } else if (st.phase === 'reveal' && st.last_reveal) {
      const r = st.last_reveal;
      stage = `<div class="card reveal">
        <p class="muted">That was</p>
        <p><b>${esc(r.title)}</b> · ${esc(r.artist)}</p>
        <p class="muted">picked by</p>
        <p class="who">${esc(r.owner_nickname)}</p>
        <p>${r.owner_eliminated ? `<span class="pill out">${esc(r.owner_nickname)} is OUT</span>` : `<span class="pill in">${esc(r.owner_nickname)} is still IN</span>`}</p>
        <p class="muted small">Waiting for the host to play the next song.</p>
      </div>`;
    } else if (st.phase === 'failed') {
      stage = '<div class="card notice"><p><b>Playback problem</b></p><p class="muted">The host is sorting it out.</p></div>';
    } else if (np) {
      stage = `<div class="card">
        <p class="muted small">${st.phase === 'paused' ? 'Paused' : 'Now playing'} · track ${np.position} of ${st.total_tracks}</p>
        <div class="row">${artwork(np.artwork_url, np.title, true)}
          <div class="grow"><div style="font-size:20px;font-weight:750">${esc(np.title)}</div><div class="muted">${esc(np.artist)}</div>
          <p class="muted small">Whose is it? Revealed when it finishes.</p></div></div>
        <div class="progress"><div id="bar"></div></div>
        <div class="times"><span id="elapsed"></span><span>${np.duration_ms ? fmtClock(np.duration_ms) : '–'}</span></div>
      </div>`;
    }
    $('stage').innerHTML = stage;
    $('hostControls').innerHTML = TEST_HOST ? hostControls(st) : '';
    $('left').textContent = st.remaining_count;
    $('chips').innerHTML = playersChips(st);
    $('history').innerHTML = st.history.length ? historyItems([...st.history].reverse()) : '<li class="muted">Nothing yet.</li>';
    tick();
  },
};

views.result = {
  shell: () => `
    <p class="brand">Last Track${TEST_HOST ? ' · test host' : ''}</p>
    <div id="banner"></div>
    <div id="rematch"></div>
    <h2>Every song, in play order</h2>
    <div class="card"><ul class="list" id="history"></ul></div>`,
  update: () => {
    const st = ui.state;
    const last = st.last_reveal;
    $('banner').innerHTML = `<div class="card banner">
      <p class="muted">Last track wins</p>
      <p class="who">${esc(st.winner?.nickname || '')}</p>
      ${last ? `<p class="muted">with <b>${esc(last.title)}</b> by ${esc(last.artist)}</p>` : ''}
    </div>`;
    $('history').innerHTML = historyItems(st.history);
    if (ui.seat.is_host) {
      $('rematch').innerHTML = '<button class="primary block" data-action="rematch">Play again</button>';
    } else if (st.rematch_code) {
      $('rematch').innerHTML = '<button class="primary block" data-action="joinRematch">Join the rematch</button>';
    } else {
      $('rematch').innerHTML = '<p class="muted center">If the host starts a rematch, a button will appear here.</p>';
    }
  },
};

function render() {
  let key;
  if (ui.removed) key = 'removed';
  else if (!ui.roomId) key = TEST_HOST ? 'create' : 'join';
  else if (!ui.state) key = 'loading';
  else key = { lobby: 'lobby', playing: 'game', finished: 'result' }[ui.state.status];
  if (key !== ui.viewKey) {
    toastEl.hidden = true; // a message from the previous screen no longer applies
    app.innerHTML = views[key].shell();
    ui.viewKey = key;
    if (key === 'lobby') wireSearch();
  }
  views[key].update?.();
}

// Smooth progress and time-left between server updates.
function tick() {
  const st = ui.state;
  if (!st || ui.viewKey !== 'game') return;
  const np = st.now_playing;
  const tl = $('timeLeft');
  if (tl) tl.textContent = `${st.remaining_is_estimate ? '≈ ' : ''}${fmtLeft(liveRemaining())}`;
  if (np && $('bar')) {
    const el = liveElapsed();
    $('elapsed').textContent = fmtClock(Math.min(el, np.duration_ms || el));
    $('bar').style.width = np.duration_ms ? `${Math.min(100, (el / np.duration_ms) * 100)}%` : '0%';
  }
  if (TEST_HOST) mockPlayerTick();
}
setInterval(tick, 1000);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function wireSearch() {
  let timer;
  let seq = 0;
  $('search').addEventListener('input', (e) => {
    clearTimeout(timer);
    const term = e.target.value;
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      try {
        const res = await catalog.search(term);
        if (mySeq === seq) { ui.results = res; render(); }
      } catch (err) {
        toast(friendly(err));
      }
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Test host: mock playback that drives the same server API as the iOS host app.
// ---------------------------------------------------------------------------

function hostControls(st) {
  const b = (action, label, cls = '') => `<button class="${cls}" data-action="${action}" ${ui.busy ? 'disabled' : ''}>${label}</button>`;
  let inner = '';
  if (st.phase === 'ready') inner = b('play', 'Play first song', 'primary block');
  else if (st.phase === 'reveal') inner = b('play', 'Play next song', 'primary block');
  else if (st.phase === 'playing') inner = `<div class="row">${b('pause', 'Pause')}${b('fail', 'Simulate playback failure', 'small')}</div>`;
  else if (st.phase === 'paused') inner = b('resume', 'Resume', 'primary block');
  else if (st.phase === 'failed') inner = `<div class="row">${b('play', 'Retry', 'primary')}${b('unplayable', 'Mark as unplayable')}</div>`;
  return `<div class="card"><p class="muted small">Host controls (mock playback, no audio)</p>${inner}</div>`;
}

async function mockPlayerTick() {
  const st = ui.state;
  const np = st?.now_playing;
  if (!np || st.phase !== 'playing' || !np.is_running || ui.completing) return;
  const dur = np.duration_ms || 30000;
  if (liveElapsed() < dur + 750) return;
  ui.completing = true;
  try {
    await rpc('host_complete_track', { p_room_id: ui.roomId, p_position: np.position });
    await refresh();
  } catch (e) {
    if (e.message !== 'track_not_finished') toast(friendly(e));
  } finally {
    setTimeout(() => { ui.completing = false; }, 1500);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function withBusy(fn) {
  if (ui.busy) return;
  ui.busy = true;
  render();
  try { await fn(); } catch (e) { toast(friendly(e)); } finally { ui.busy = false; render(); }
}

const actions = {
  async add(id) {
    const s = ui.results.find((r) => r.id === id);
    if (!s) return;
    const res = await rpc('add_nomination', {
      p_room_id: ui.roomId, p_song_id: s.id, p_title: s.title, p_artist: s.artist,
      p_duration_ms: s.durationMs, p_artwork_url: s.artworkUrl,
    });
    if (!res.ok) {
      if (res.error === 'already_selected') ui.taken.add(s.id);
      toast(friendly(res.error));
    }
    await loadMine();
  },
  async remove(id) {
    await rpc('remove_nomination', { p_room_id: ui.roomId, p_nomination_id: id });
    await loadMine();
  },
  async kick(id) {
    const p = ui.state.players.find((x) => x.id === id);
    if (!confirm(`Remove ${p?.nickname} from the game? Their songs will be dropped.`)) return;
    await rpc('remove_participant', { p_room_id: ui.roomId, p_participant_id: id });
  },
  async go() {
    await rpc('lock_room', { p_room_id: ui.roomId });
    if (TEST_HOST) await rpc('host_play', { p_room_id: ui.roomId });
    await refresh();
  },
  async play() { await rpc('host_play', { p_room_id: ui.roomId }); await refresh(); },
  async pause() { await rpc('host_set_paused', { p_room_id: ui.roomId, p_position: ui.state.now_playing.position, p_paused: true }); await refresh(); },
  async resume() { await rpc('host_set_paused', { p_room_id: ui.roomId, p_position: ui.state.now_playing.position, p_paused: false }); await refresh(); },
  async fail() { await rpc('host_report_failure', { p_room_id: ui.roomId, p_position: ui.state.now_playing.position }); await refresh(); },
  async unplayable() {
    if (!confirm('Mark this song as unplayable? It will be revealed and count as played.')) return;
    const pos = ui.state.history.length + 1;
    await rpc('host_mark_unplayable', { p_room_id: ui.roomId, p_position: pos });
    await refresh();
  },
  async rematch() {
    const seat = await rpc('create_rematch', { p_room_id: ui.roomId });
    await enterRoom({ ...seat, nickname: ui.seat.nickname });
  },
  async joinRematch() {
    const nick = ui.seat.nickname || store.get('nickname');
    const seat = await rpc('join_room', { p_code: ui.state.rematch_code, p_nickname: nick });
    await enterRoom({ ...seat, nickname: nick });
  },
  async leave() { ui.removed = false; leaveRoom(); },
};

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const fn = actions[btn.dataset.action];
  if (fn) withBusy(() => fn(btn.dataset.id));
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'joinForm') {
    const code = $('code').value.trim().toUpperCase();
    const nick = $('nick').value.trim();
    withBusy(async () => {
      const seat = await rpc('join_room', { p_code: code, p_nickname: nick });
      store.set('nickname', nick);
      await enterRoom({ ...seat, nickname: nick });
    });
  } else if (e.target.id === 'createForm') {
    const nick = $('nick').value.trim();
    const quota = Number(new FormData(e.target).get('quota'));
    withBusy(async () => {
      const seat = await rpc('create_room', { p_nickname: nick, p_song_quota: quota });
      store.set('nickname', nick);
      await enterRoom({ ...seat, nickname: nick });
    });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    await ensureSession();
  } catch {
    app.innerHTML = '<p class="center">Could not connect. Check your internet connection and reload.</p>';
    return;
  }
  const wantedCode = (params.get('code') || '').toUpperCase();
  const saved = store.get('room');
  if (saved) {
    try {
      const seat = await rpc('get_my_seat', { p_room_id: saved });
      const { data } = await sb.from('room_public_state').select('state').eq('room_id', saved).maybeSingle();
      if (!wantedCode || data?.state?.code === wantedCode) {
        await enterRoom(seat);
        return;
      }
    } catch {
      store.del('room');
    }
  }
  render();
}

boot();
