#!/usr/bin/env bash
# Runs the backend test suite against a throwaway local Postgres 16 cluster.
# Usage: ./run-tests.sh            (needs Postgres 16 server binaries and Node 20+)
set -euo pipefail
cd "$(dirname "$0")"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/postgres" ] || PGBIN="$(dirname "$(command -v postgres)")"
DATA="$(mktemp -d)"; PORT="${PORT:-54329}"
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DATA"
as_pg "$PGBIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
as_pg "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=localhost -c wal_level=logical" -l "$DATA/log" -w start >/dev/null
trap 'as_pg "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null; rm -rf "$DATA"' EXIT
export DATABASE_URL="postgres://postgres@localhost:$PORT/postgres"
psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase-stub.sql
for f in ../supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$f"; done
[ -d node_modules ] || npm install --silent
node --test --test-concurrency=1 "test/*.test.js"
