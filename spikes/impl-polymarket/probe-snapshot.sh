#!/usr/bin/env bash
# Polymarket snapshot sampler — Phase 0 spike evidence for Q3 (local snapshot feasibility).
# Samples gamma (per-event market price/volume/updatedAt) and CLOB midpoint for the three
# upcoming FOMC decision events, at a fixed interval, into raw/snapshots.jsonl (one JSON per
# market per tick). Raw per-tick gamma responses are kept as raw/snap-<tick>-gamma.json.
#
# usage: probe-snapshot.sh <total_sec> <interval_sec>
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RAW="$DIR/raw"
OUT="$RAW/snapshots.jsonl"
LOG="$RAW/SNAPSHOT-LOG.txt"
UA="Mozilla/5.0"
TOTAL="${1:-420}"
INTERVAL="${2:-60}"
mkdir -p "$RAW"
: > "$OUT"
: > "$LOG"

tick=0
start=$(date +%s)
end=$(( start + TOTAL ))
while [ "$(date +%s)" -lt "$end" ]; do
  tick=$(( tick + 1 ))
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  G="$RAW/snap-${tick}-gamma.json"
  code=$(curl -sS -A "$UA" -o "$G" -w "%{http_code}" \
    "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=100")
  echo "$TS tick=$tick gamma http=$code bytes=$(wc -c <"$G" | tr -d ' ')" >> "$LOG"

  for MONTH in October December January; do
    jq -r --arg m "$MONTH" '.[]|select(.title|test("Fed Decision in "+$m))|.slug' "$G" 2>/dev/null \
    | while read -r slug; do
        [ -z "$slug" ] && continue
        jq -r --arg s "$slug" \
          '.[]|select(.slug==$s)|.markets[]|[.groupItemTitle,(.clobTokenIds|fromjson|.[0]),(.outcomePrices|fromjson|.[0]),(.bestBid|tostring),(.bestAsk|tostring),.updatedAt]|@tsv' \
          "$G" 2>/dev/null \
        | while IFS=$'\t' read -r bucket tok gpx bid ask upd; do
            mid=$(curl -sS -A "$UA" "https://clob.polymarket.com/midpoint?token_id=$tok" | jq -r '.mid // "ERR"')
            jq -cn --arg ts "$TS" --argjson tick "$tick" --arg slug "$slug" --arg bucket "$bucket" \
              --arg mid "$mid" --arg gpx "$gpx" --arg bid "$bid" --arg ask "$ask" --arg upd "$upd" \
              '{ts:$ts,tick:$tick,event:$slug,bucket:$bucket,gamma_price:($gpx|tonumber),clob_mid:($mid|tonumber?),best_bid:($bid|tonumber),best_ask:($ask|tonumber),market_updatedAt:$upd}' \
              >> "$OUT"
          done
      done
  done
  sleep "$INTERVAL"
done
echo "DONE ticks=$tick at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
