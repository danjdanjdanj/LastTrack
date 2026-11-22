# Last Track: architecture and plan

Status: backend built and tested (25 tests passing). iOS client on hold until a Mac is connected.

## 1. Architecture

1. **iOS app (SwiftUI, iOS 17+).** Thin client. Three swappable services behind protocols:
   - a. `CatalogService`: Apple Music search (MusicKit, AU catalogue) or a mock.
   - b. `PlaybackService`: `ApplicationMusicPlayer` with a one-song queue, or a mock timer player.
   - c. `GameBackend`: Supabase RPC plus Realtime, or an in-memory fake for UI tests and previews.
2. **Supabase.** Postgres, anonymous auth and Realtime.
   - a. All real tables live in schema `private`, which API roles cannot reach.
   - b. Clients call 15 `SECURITY DEFINER` functions only. Each one checks the session, room membership, host role and room state.
   - c. The one readable table is `public.room_public_state`, a whitelisted JSON document per room, protected by RLS and streamed by Realtime.
3. **Apple Music.** Only the host's device plays music. Players' devices only search. No audio is stored, only catalogue IDs and display metadata.

## 2. How the brief's guarantees are enforced

| Requirement | Mechanism |
|---|---|
| No accounts | Supabase anonymous sign-in; session in the iOS Keychain |
| Duplicate song IDs blocked atomically | `unique(room_id, apple_music_song_id)` with `on conflict do nothing`; tested with 12 simultaneous adds |
| Neutral duplicate message | Returns only `already_selected` |
| Equal quota | Row lock per player, plus an exact-count check on ready and on lock |
| Nobody sees others' picks, including the host | Private schema; `my_nominations` returns the caller's own only |
| One unbiased shuffle, never changed | Fisher–Yates using `gen_random_bytes` with rejection sampling, run once inside `lock_room` under a row lock; chi-square tested |
| Host can't see the future queue | `host_play` returns one song ID, at the moment it starts |
| No per-player counts leaked | State JSON keys are whitelisted; a test walks a full game and checks every player's view after each step |
| IN/OUT only changes on reveal | Status is derived from completed entries only; the current track counts as remaining |
| Winner = owner of the last track | Set server-side when the last position completes |
| No skipping | Completion rejected unless the server clock shows the track has nearly finished (10s tolerance) |
| Recovery | `host_play` is idempotent and returns the current track plus elapsed time; clients refetch state on reconnect |

**Conventions:**
1. `remaining_count` includes the track currently playing.
2. Missing durations are replaced by the average of known durations, with `remaining_is_estimate=true`.

## 3. Game state machine

`lobby → ready → playing ⇄ paused → reveal → (host taps Play next) → playing … → finished`

On a playback error: `playing/paused → failed → playing` (retry) or `reveal` (marked unplayable).

## 4. Apple Music findings

1. MusicKit for Swift, catalogue search, `ApplicationMusicPlayer` and `MusicSubscription` all need iOS 15+, so iOS 17 is fine.
2. Apple generates the developer token automatically once the MusicKit App Service is enabled on the App ID. No private key goes in the app, and no server-side token is needed for iOS.
3. Background play needs the `audio` background mode in Info.plist.
4. Check `MusicSubscription.current.canPlayCatalogContent` on the host's device before locking.
5. **Not verified in the docs:** whether catalogue search needs `.authorized` consent or a subscription. Plan: every player taps "Allow Apple Music" once, and we test on a non-subscribed device. If search fails there, the fallback is a small Supabase Edge Function that proxies search with a server-held MusicKit key. That would need your approval.
6. **Not verified in the docs:** AirPlay behaviour. Expected to follow standard iOS audio routes; test on a device.
7. Licensing and usage terms for games are unclear. Check the Apple Music identity guidelines and terms before any commercial release.

## 5. Phased plan

1. Done: backend schema, API, privacy and security tests.
2. Next (needs Mac): Xcode project; mock services; all eight screens; full four-simulator game against local Supabase.
3. Real MusicKit search (AU) and playback behind the same protocols.
4. Reconnect and backgrounding hardening, plus UI tests.
5. Device testing (see section 7).

## 6. Decisions pending approval

1. **Mid-game unplayable track.** Unplayable tracks are prevented up front: players can only pick songs that are playable in the AU catalogue, and must replace them before submitting. A track can still fail mid-game. In that case the host can retry, then mark it unplayable: it's revealed, counts as played for its owner, and the order is unchanged. Approve or change.
2. **Reveal advance.** The host taps "Play next" after each reveal, as the brief prefers. There's no auto-advance.
3. **Final track.** It plays to completion before the winner is shown, as the brief's default.
4. **Room limits.** 2 to 16 players. Rooms are not cleaned up automatically yet; I'll add a daily purge of rooms older than 48 hours.
5. **Song metadata.** Title, artist and duration are supplied by the client. A tampered client could only mislabel its own song. Server-side validation would need the search-proxy option above.

## 7. Physical iPhone testing required

1. Host with an active Apple Music subscription: full game, background play, screen locked, AirPlay or Bluetooth.
2. Player without a subscription: search works (open question 4.5).
3. Host with Screen Time explicit-content restrictions: what happens with explicit songs.
4. Network drop on host and players mid-track; host force-quit and relaunch.
