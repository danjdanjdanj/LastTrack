# Last Track

Everyone picks the music. Nobody controls the playlist. Last track wins.

The host runs the iPhone app and plays the music. Players join on a web page (no app, no account), secretly pick songs, then follow the live game.

- `supabase/`: database schema and server API (migrations), Apple Music search function, CLI config.
- `web/`: player website (`index.html`) and a browser test host with mock playback (`host.html`).
- `backend-tests/`: privacy, security and game-logic tests for the database.
- `web-tests/`: end-to-end browser test (host plus 3 players, full game).
- `docs/ARCHITECTURE.md`: design, privacy rules, status, open items.
- `docs/IOS_HOST_HANDOFF.md`: brief for building the iOS host app on a Mac.

## Test

Backend (needs Postgres 16 server binaries and Node 20+):

```bash
cd backend-tests && npm install && ./run-tests.sh
```

Browser end-to-end (needs Docker, the Supabase CLI and Playwright):

```bash
npx supabase start
node web-tests/e2e.mjs
```

On machines without IPv6, set `[realtime] enabled = false` in `supabase/config.toml` and run with `NO_REALTIME=1`.

## Try it locally in a browser

1. Run `npx supabase start`.
2. Point `web/config.js` at the local stack (`http://127.0.0.1:54321` and the printed anon key); the committed file points at the live project.
3. Serve `web/` with any static server, for example `npx http-server web -p 8080`.
4. Open `http://localhost:8080/host.html` to host, and `index.html?code=…&seat=2` in other tabs as players (`seat` keeps tabs separate).
