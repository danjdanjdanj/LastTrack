# Last Track

Everyone picks the music. Nobody controls the playlist. Last track wins.

- `supabase/`: database schema and server API (migrations), Supabase CLI config.
- `backend-tests/`: privacy, security and game-logic tests for the backend.
- `docs/ARCHITECTURE.md`: architecture, Apple Music findings, plan and open decisions.
- `ios/`: SwiftUI app (not yet started; needs a Mac).

## Run backend tests

Needs Postgres 16 server binaries and Node 20+.

```bash
cd backend-tests && npm install && ./run-tests.sh
```

## Deploy backend (later)

1. Create a Supabase project; enable Anonymous sign-ins (Authentication → Providers).
2. `supabase link --project-ref <ref>` then `supabase db push`.
3. Keep `private` out of the API's exposed schemas.
