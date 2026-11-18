#!/usr/bin/env bash
# Builds sandbox/Dockerfile as a new version of an Orrery Snapshot, waits for it, and prints the Snapshot's name
# for /console/sandbox. Needs curl and jq.
#   ORRERY_URL=https://orrery.example.com ORRERY_TOKEN=orr_... scripts/sandbox-snapshot.sh
# SNAPSHOT (default orqestra) names the Snapshot, created if missing; BASE (default ubuntu-24.04) is the platform Snapshot to build on.
set -euo pipefail
: "${ORRERY_URL:?the Orrery address, without /api/v1}" "${ORRERY_TOKEN:?an Orrery API Token with user scope}"
SNAPSHOT="${SNAPSHOT:-orqestra}"
BASE="${BASE:-ubuntu-24.04}"
DOCKERFILE="$(dirname "$0")/../sandbox/Dockerfile"

api() {
	local out
	out=$(curl -sS --fail-with-body -H "Authorization: Bearer $ORRERY_TOKEN" -H 'Content-Type: application/json' "$@") ||
		{ printf '%s\n' "$out" >&2; return 1; }
	printf '%s\n' "$out"
}

id="" cursor=""
while :; do
	page=$(api -G "$ORRERY_URL/api/v1/snapshots" --data limit=200 ${cursor:+--data-urlencode "cursor=$cursor"})
	id=$(jq -r --arg n "$SNAPSHOT" 'first(.items[] | select(.owner_id != null and .name == $n) | .id) // empty' <<<"$page")
	cursor=$(jq -r '.next_cursor // empty' <<<"$page")
	if [ -n "$id" ] || [ -z "$cursor" ]; then break; fi
done
if [ -z "$id" ]; then
	id=$(jq -n --arg n "$SNAPSHOT" '{name: $n}' | api -X POST "$ORRERY_URL/api/v1/snapshots" -d @- | jq -r .id)
fi

version=$(jq -n --rawfile d "$DOCKERFILE" --arg b "$BASE" '{build: {dockerfile: $d, base: $b}}' |
	api -X POST "$ORRERY_URL/api/v1/snapshots/$id/versions" -d @-)
vid=$(jq -r .id <<<"$version")
echo "building $SNAPSHOT version $vid, log in Exec $(jq -r .build_exec_id <<<"$version")" >&2

while state=$(api "$ORRERY_URL/api/v1/snapshots/$id/versions/$vid" | jq -r '.state + " " + (.cause // "")') &&
	[ "${state%% *}" = building ]; do
	sleep 5
done
if [ "${state%% *}" != ready ]; then
	echo "build ended $state" >&2
	exit 1
fi
echo "$SNAPSHOT"
