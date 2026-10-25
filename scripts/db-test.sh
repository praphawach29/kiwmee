#!/usr/bin/env bash
# Rebuilds a throwaway database from supabase/migrations + seed on a plain local Postgres,
# with supabase/tests/supabase-shim.sql standing in for the roles and auth schema a Supabase
# project provides, then runs the database tests against it.
#
#   SUPABASE_TEST_DB_URL=postgres://postgres@localhost:54329/booking_test scripts/db-test.sh
#
# The database named in the URL is dropped and recreated. Never point this at a real project.
set -euo pipefail

url="${SUPABASE_TEST_DB_URL:?set SUPABASE_TEST_DB_URL to a throwaway local database}"
case "$url" in
  *supabase.co*|*supabase.com*) echo "refusing to run against a hosted Supabase database" >&2; exit 1 ;;
esac

db="${url##*/}"; db="${db%%\?*}"
admin_url="${url%/*}/postgres"
here="$(cd "$(dirname "$0")/.." && pwd)"

psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$db\" with (force)" -c "create database \"$db\""
psql "$url" -v ON_ERROR_STOP=1 -q -f "$here/supabase/tests/supabase-shim.sql"
for f in "$here"/supabase/migrations/*.sql; do
  psql "$url" -v ON_ERROR_STOP=1 -q -f "$f"
done
psql "$url" -v ON_ERROR_STOP=1 -q -f "$here/supabase/seed.sql"

SUPABASE_TEST_DB_URL="$url" node --test "$here"/supabase/tests/*.test.js
