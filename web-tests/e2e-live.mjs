// End-to-end browser test: test host + 3 players, full game, against a local Supabase stack.
// Usage: node web-tests/e2e.mjs   (needs `supabase start` running and Playwright available)
import { createRequire } from 'node:module';
// CommonJS require honours NODE_PATH, so a globally installed Playwright works too.
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WEB = path.join(ROOT, 'web');
const DB = process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SHOTS = process.env.SHOTS_DIR || null;

function supabaseStatus() {
  const out = execFileSync('npx', ['-y', 'supabase@2.20.12', 'status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8' });
  const env = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
  }));
  return { url: env.API_URL, anon: env.ANON_KEY };
}

function psql(sql) {
  return execFileSync('psql', [DB, '-At', '-c', sql], { encoding: 'utf8' }).trim();
}

// Static server for web/, with config.js generated for the local stack.
function serve(cfgJs) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(cfgJs);
    }
    const file = path.join(WEB, path.normalize(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Record everything a player's browser receives (HTTP bodies and realtime frames).
function recordTraffic(page, sink) {
  page.on('response', async (r) => {
    try { sink.push(await r.text()); } catch { /* bodies of redirects etc. */ }
  });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => sink.push(String(f.payload))));
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const LIVE = !!process.env.LIVE;
const { url, anon } = LIVE
  ? (() => { const c = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8');
      return { url: c.match(/supabaseUrl:\s*'([^']+)'/)[1], anon: c.match(/supabaseAnonKey:\s*'([^']+)'/)[1] }; })()
  : supabaseStatus();
const server = await serve(`window.LAST_TRACK_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: anon, catalog: 'mock', realtime: process.env.NO_REALTIME ? false : true, pollMs: process.env.NO_REALTIME ? 700 : LIVE ? 3600000 : 10000 })};`);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const errors = [];
const allPages = [];

try {
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    allPages.push([label, page]);
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
    return page;
  };

  // Host creates a 3-song game.
  const host = await newPage('host');
  await host.goto(`${base}/host.html`);
  await host.fill('#nick', 'Danya');
  await host.check('input[name=quota][value="3"]');
  await host.click('button[type=submit]');
  await host.waitForSelector('#search');
  const code = (await host.textContent('.code')).trim();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);

  // Three players join from the share link. No app, no account.
  const names = ['Tim', 'Ava', 'Sam'];
  const traffic = { Tim: [], Ava: [], Sam: [] };
  const players = [];
  for (const n of names) {
    const p = await newPage(n);
    recordTraffic(p, traffic[n]);
    await p.goto(`${base}/index.html?code=${code}`);
    await p.fill('#nick', n);
    await p.click('button[type=submit]');
    await p.waitForSelector('#search');
    players.push(p);
  }

  async function pick(page, term, count) {
    await page.fill('#search', term);
    await page.waitForFunction((t) => {
      const rows = [...document.querySelectorAll('#results li')];
      return rows.length > 0 && rows.every((li) => li.textContent.includes(t));
    }, term);
    for (let i = 0; i < count; i++) {
      const btn = page.locator('#results button:not([disabled])').first();
      await btn.click();
      await page.waitForFunction((n) => document.querySelectorAll('#mine li .art').length >= n, i + 1);
    }
  }
  const mineTitles = async (page) => page.$$eval('#mine li b', (els) => els.map((e) => e.textContent));

  await pick(host, 'Tame Impala', 3);
  await pick(players[0], 'Courtney', 3);
  await pick(players[1], 'Spacey', 2);

  // Host sees per-player counts and GO stays disabled until everyone is full.
  await host.waitForFunction(() => document.querySelector('#players').textContent.includes('2/3'));
  const lobbyText = await host.textContent('#players');
  for (const s of ['Danya', '3/3', 'Tim', 'Ava', '2/3', 'Sam', '0/3']) assert.ok(lobbyText.includes(s), `lobby shows ${s}`);
  assert.equal(await host.isDisabled('#go'), true, 'GO disabled while players are short');
  await shot(host, '1-host-lobby');

  // Duplicate: Sam tries Tim's song and gets the neutral message.
  const timsSong = (await mineTitles(players[0]))[0];
  await players[2].fill('#search', 'Courtney');
  await players[2].waitForSelector('#results li');
  const row = players[2].locator('#results li', { hasText: timsSong });
  await row.locator('button').click();
  await players[2].waitForSelector('#toast:not([hidden])');
  assert.equal((await players[2].textContent('#toast')).trim(), 'Already selected. Pick another song.');
  assert.ok(!(await players[2].textContent('#toast')).includes('Tim'), 'does not name the chooser');
  await players[2].waitForFunction((t) => [...document.querySelectorAll('#results li')]
    .some((li) => li.textContent.includes(t) && li.querySelector('button').textContent === 'Taken'), timsSong);
  await shot(players[2], '2-player-duplicate');

  await pick(players[2], 'Ruel', 3);
  await pick(players[1], 'Spacey', 1);
  await host.waitForFunction(() => !document.querySelector('#go').disabled);
  await shot(players[1], '3-player-picks');

  // Everyone's picks, for leak checking.
  const allPicks = {};
  allPicks.Danya = await mineTitles(host);
  for (let i = 0; i < 3; i++) allPicks[names[i]] = await mineTitles(players[i]);
  const ownerOf = new Map(Object.entries(allPicks).flatMap(([o, ts]) => ts.map((t) => [t, o])));
  assert.equal(ownerOf.size, 12, '12 unique songs');

  // No database access on the live project: map picks to song IDs via the mock catalogue.
  const { MockCatalog } = await import(new URL('../web/catalog.js', import.meta.url));
  const cat = new MockCatalog().songs;
  const detail = async (page) => page.$$eval('#mine li', (lis) => lis.map((li) => ({
    title: li.querySelector('b').textContent, artist: li.querySelector('.muted').textContent })));
  const picks = []; // { id, title, owner }
  for (const [owner, page] of [['Danya', host], ...names.map((n, k) => [n, players[k]])]) {
    for (const d of await detail(page)) {
      const song = cat.find((c) => c.title === d.title && c.artist === d.artist);
      picks.push({ id: song.id, title: d.title, owner });
    }
  }
  assert.equal(new Set(picks.map((p) => p.id)).size, 12);
  // GO: shuffles, locks and starts.
  await host.click('#go');
  await host.waitForSelector('#stage .card');
  for (const p of players) await p.waitForSelector('#left');
  const LONG = { timeout: 120000 };

  const played = [];
  for (let i = 1; i <= 12; i++) {
    for (const p of players) {
      await p.waitForFunction((n) => document.querySelector('#stage')?.textContent.includes(`track ${n} of 12`), i, LONG);
    }
    const title = (await players[0].textContent('#stage [style*="font-size:20px"]')).trim();
    played.push(title);
    assert.equal((await players[0].textContent('#left')).trim(), String(13 - i), 'tracks left includes current');
    assert.ok(!(await players[1].textContent('#stage')).includes('picked by'), 'owner hidden while playing');

    // Privacy: no player has received any song not yet played (other than their own picks).
    for (const n of names) {
      const blob = traffic[n].join('\n');
      for (const pk of picks) {
        if (pk.owner === n || played.includes(pk.title)) continue;
        assert.ok(!blob.includes(pk.id), `${n} received an upcoming song early (track ${i})`);
      }
    }

    if (i < 12) {
      const owner = picks.find((p) => p.title === title).owner;
      await players[2].waitForFunction((t) => {
        const st = document.querySelector('#stage')?.textContent || '';
        return st.includes('picked by') && st.includes(t);
      }, title, LONG);
      assert.ok((await players[2].textContent('#stage')).includes(owner), `reveal names ${owner}`);
      await host.waitForSelector('[data-action=play]', LONG);
      await host.click('[data-action=play]');
    }
    console.log(`track ${i}/12 ok`);
  }
  const queue = played.map((t) => ({ title: t, owner: picks.find((p) => p.title === t).owner }));

  // Result: winner is the owner of the final track.
  for (const p of [host, ...players]) await p.waitForSelector('.banner .who', { timeout: 120000 });
  const winner = (await players[0].textContent('.banner .who')).trim();
  assert.equal(winner, queue[11].owner, 'owner of the final track wins');
  assert.equal(await players[1].locator('#history li').count(), 12);
  await shot(players[0], '6-player-result');

  for (const n of names) {
    const blob = traffic[n].join('\n');
    const afterLock = blob.slice(blob.indexOf('"status":"playing"'));
    assert.ok(!/"submitted_count":\s*\d/.test(afterLock), 'no per-player counts during play');
  }

  // Rematch: host starts, players get a join button.
  await host.click('[data-action=rematch]');
  await players[0].waitForSelector('[data-action=joinRematch]', { timeout: 15000 });
  await players[0].click('[data-action=joinRematch]');
  await players[0].waitForSelector('#search');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`E2E PASS: 12 tracks played, winner ${winner}, code ${code}`);
} catch (e) {
  if (SHOTS) for (const [l, p] of allPages) await p.screenshot({ path: path.join(SHOTS, `fail-${l}.png`), fullPage: true }).catch(() => {});
  console.error('page errors:', errors);
  throw e;
} finally {
  await browser.close();
  server.close();
}
