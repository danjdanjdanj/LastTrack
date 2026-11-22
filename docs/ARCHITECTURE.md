# Last Track: architecture and plan

## 1. Shape of the product

1. **Host:** the only person with the iPhone app. Sets songs per player (3, 4 or 5), shares a QR code, picks their own songs, watches the lobby (for example "Danya 5/5, Tim 4/5"), presses **GO!** and plays everything through their Apple Music.
2. **Players:** scan the QR code and use a web page. No app and no account. They pick songs secretly, then follow the live dashboard, reveals and result on the same page.
3. **Backend:** Supabase (Postgres, anonymous sign-in, Realtime, one Edge Function for Apple Music search).

## 2. Status

| Part | Status |
|---|---|
| Database schema and server API | Done; 25 tests pass on plain Postgres 16 and on Supabase's Postgres image |
| Player website (`web/`) | Done with mock songs; browser test passes (host plus 3 players, 12 tracks) |
| Browser test host (`web/host.html`) | Done; mock playback, no audio, for testing only |
| Apple Music search function | Written, not yet run (needs a MusicKit key) |
| iOS host app | Not started; needs a Mac (see `docs/IOS_HOST_HANDOFF.md`) |
| Live updates (Realtime) | Coded; not testable in the cloud workspace (no IPv6), so tested with polling |

## 3. Privacy and fairness rules, and how they're enforced

| Requirement | Mechanism |
|---|---|
| No accounts | Supabase anonymous sign-in. Players' sessions are stored in the browser; the host's session is stored in the iOS Keychain |
| Duplicate songs blocked atomically | Unique index on (room, Apple Music song ID). Tested with 12 simultaneous adds |
| Neutral duplicate message | Server says only `already_selected`; page shows "Already selected. Pick another song." |
| Lobby counts | `submitted_count` per player, lobby only. Nulled the moment the game locks |
| GO needs everyone full | `lock_room` checks every active player has exactly the quota, under a row lock |
| Nobody sees others' picks, host included | All real tables are in a `private` schema that clients cannot reach. `my_nominations` returns the caller's own only |
| One unbiased shuffle, never changed | Fisher–Yates with `gen_random_bytes` and rejection sampling, inside `lock_room`. Chi-square tested |
| Host can't see the future queue | `host_play` returns one song ID, at the moment it starts |
| Nothing leaks over the network | Clients read one whitelisted JSON document per room (RLS: members only). Browser test records every response a player receives and checks that no upcoming song appears before it plays |
| IN/OUT changes only on reveal | Derived from completed tracks; the playing track counts as remaining |
| Winner | Owner of the last track in the locked order, set by the server |
| No skipping | Server rejects "track finished" until the track has nearly played out by the server clock |
| Recovery | `host_play` is idempotent and returns the current track and elapsed time. Pages re-fetch on reconnect, when brought back on screen and every 10s |
| Unplayable songs | Search only offers songs playable in the AU catalogue, so players replace before GO. If one still fails mid-game: retry, then the host marks it unplayable (revealed, counts as played, order unchanged). Approved |

**Conventions:**
1. "Tracks left" includes the track currently playing.
2. Missing durations use the average of known durations, and time left shows "≈".

## 4. Apple Music

1. **Catalogue:** Australia (`au`) only.
2. **Host app:** MusicKit `ApplicationMusicPlayer`. The developer token is automatic once the MusicKit App Service is enabled on the App ID, so no key goes in the app. Needs the `audio` background mode. Check `MusicSubscription.current.canPlayCatalogContent` before GO.
3. **Player search:** the website can't use MusicKit on iPhone, so `supabase/functions/catalog-search` calls the Apple Music API (`/v1/catalog/au/search`) with a developer token signed on the server.
   - a. Needs a MusicKit private key (Apple Developer account → Keys).
   - b. Stored as Supabase function secrets: `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_PRIVATE_KEY`.
4. **Not yet verified on a device:** AirPlay and Bluetooth routes, Screen Time explicit-content restrictions on the host phone, and long background play.
5. **Terms:** check Apple Music identity guidelines and usage terms before any commercial release.

## 5. Next steps

1. iOS host app on a Mac (handoff brief written).
2. Create the Supabase project, deploy the schema and search function, host `web/` (GitHub Pages is the simplest option), and switch `catalog` to `apple`.
3. Device test with a real Apple Music subscription (section 6).

## 6. Must be tested on real devices

1. Host iPhone with an Apple Music subscription: full game, screen locked, app in background, AirPlay or Bluetooth.
2. Players on iPhone Safari and Android Chrome: join by QR code, search, live updates.
3. Wi-Fi drop on host and players mid-track; host force-quits and relaunches.
4. Host with Screen Time explicit-content restrictions turned on.

## 7. Known limitations

1. Song metadata comes from the player's browser. A tampered page could mislabel only its own song. The order and the owners are unaffected.
2. Rooms and all their data are deleted 48 hours after creation (hourly pg_cron job).
3. Up to 16 players per room.
