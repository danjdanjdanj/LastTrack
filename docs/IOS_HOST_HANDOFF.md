# Brief: build the Last Track iOS host app

For a Claude Code session running on a Mac with Xcode 16+. Read `docs/ARCHITECTURE.md` first.

## Scope

Only the host uses the app. Players use the website in `web/`. Build the smallest SwiftUI app (iOS 17+) that does the following:

1. **Create:** nickname; songs per player 3, 4 or 5 (default 5) → `create_room(p_nickname, p_song_quota)`.
2. **Lobby:**
   - a. Show the game code and a QR code (CoreImage `CIQRCodeGenerator`) for `<WEB_URL>/index.html?code=CODE`.
   - b. Host picks their own songs using MusicKit search (AU storefront), calling `add_nomination` / `remove_nomination` / `my_nominations`.
   - c. Player list with `submitted_count/song_quota`, for example "Tim 4/5", plus Remove (`remove_participant`).
   - d. **GO!** enabled only when everyone is full and there are at least 2 players.
   - e. Before GO, check `MusicSubscription.current.canPlayCatalogContent`. If false, explain that the host needs Apple Music.
3. **GO:** `lock_room`, then `host_play` → play the returned `song_id` with `ApplicationMusicPlayer` (queue of exactly one song, shuffle off).
4. **Playing:** same dashboard as the website.
   - a. On natural end of track, call `host_complete_track(position)`, then show the reveal.
   - b. On the reveal screen, a **Play next** button calls `host_play` again.
   - c. Pause and resume call `host_set_paused`. No seek or skip controls.
5. **Failure:**
   - a. On a playback error, call `host_report_failure` and offer **Retry** (`host_play`) or **Mark unplayable** (`host_mark_unplayable`).
6. **Recovery:** on relaunch or return to the foreground, re-read state. If the phase is playing or paused, call `host_play` to get the current track and `elapsed_ms`, and resume playback from that point.
7. **Result:** winner and history; **Play again** → `create_rematch`.

The server API and JSON shapes are in `supabase/migrations/*.sql`; `web/app.js` is a working reference client for every call, including the test host's mock player.

## Structure

- `GameBackend` protocol: `SupabaseGameBackend` (supabase-swift, anonymous auth, RPC, Realtime on `room_public_state`, polling fallback) and `FakeGameBackend` for previews and UI tests.
- `CatalogService`: `MusicKitCatalog` and `MockCatalog` (same mock songs as `web/catalog.js`).
- `PlaybackService`: `MusicKitPlayback` and `MockPlayback` (a timer), so the full game runs in the Simulator without Apple Music.

## Setup the person must do

1. Apple Developer: create an explicit App ID with the bundle ID; enable the **MusicKit** App Service.
2. Xcode: Signing team; Background Modes → Audio; `NSAppleMusicUsageDescription` in Info.plist.
3. `Secrets.xcconfig` (gitignored): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WEB_URL`.

## Done when

1. Unit tests for state mapping and the mock playback loop pass.
2. In the Simulator with `MockPlayback`, a full game against local Supabase (`supabase start`) and three browser players completes.
3. On a physical iPhone with Apple Music, real tracks play in order, including with the screen locked.
