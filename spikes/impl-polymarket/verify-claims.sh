#!/usr/bin/env bash
# Re-derives every structural claim in EVIDENCE.md from the committed raw responses.
# No network: this runs against raw/ only, so a third party can verify the evidence offline.
# Usage: ./verify-claims.sh
set -u
cd "$(dirname "$0")"
R=raw
pass=0; fail=0
chk() { # chk <label> <actual> <expected>
  if [ "$2" = "$3" ]; then printf "PASS  %-58s %s\n" "$1" "$2"; pass=$((pass+1))
  else printf "FAIL  %-58s got=%s want=%s\n" "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo "== Q0: UA matrix (recorded observations) =="
chk "403 reproduction rows in UA-MATRIX (data rows)" \
    "$(grep -v '^#' $R/UA-MATRIX.txt | grep -c '403')" "2"
chk "200 rows in UA-MATRIX (data rows)" \
    "$(grep -v '^#' $R/UA-MATRIX.txt | grep -c ' 200 ')" "7"

echo "== Q1: discovery rule =="
chk "series_id=35 candidate count"          "$(jq 'length' $R/06-events-series_id35.json)" "39"
chk "events carrying series[].id=35"       "$(jq '[.[]|select((.series//[])|map(.id)|index("35"))]|length' $R/06-events-series_id35.json)" "39"
chk "noise titles inside series 35"        "$(jq '[.[]|select(.title|test("hike|Warsh|fire|parlay|dissent|Powell|Bingo";"i"))]|length' $R/06-events-series_id35.json)" "0"
chk "seriesSlug=fomc members (stale slug)" "$(jq '[.[]|select(.seriesSlug=="fomc")]|length' $R/06-events-series_id35.json)" "8"
chk "seriesSlug=fed-interest-rates members" "$(jq '[.[]|select(.seriesSlug=="fed-interest-rates")]|length' $R/06-events-series_id35.json)" "31"
chk "tag_slug=fomc open candidates"        "$(jq 'length' $R/01-events-fomc-limit100.json)" "9"
chk "tag_slug=fomc incl closed"            "$(jq 'length' $R/03-events-fomc-closed-incl.json)" "46"
chk "4-bucket meetings (shape-filtered)"   "$(jq '[.[]|select(.negRisk==true and (.markets|length)==4)]|length' $R/06-events-series_id35.json)" "14"
chk "5-bucket meetings (shape-filtered)"   "$(jq '[.[]|select(.negRisk==true and (.markets|length)==5)]|length' $R/06-events-series_id35.json)" "7"
chk "6-bucket meetings (shape-filtered)"   "$(jq '[.[]|select(.negRisk==true and (.markets|length)==6)]|length' $R/06-events-series_id35.json)" "2"
chk "slug has random 17-digit suffix"      "$(jq -r '.[]|select(.title|test("Fed Decision in October"))|.slug' $R/01-events-fomc-limit100.json | grep -cE '[0-9]{17}$')" "1"
chk "2027-01 slug suffix is a 2026 build date" \
    "$(jq -r '.[]|select(.title|test("Fed Decision in January"))|.slug' $R/01-events-fomc-limit100.json | grep -c '20260729')" "1"

echo "== Q2: probability caliber =="
chk "gamma==clob_mid on all buckets (15/15)" \
    "$(jq '[.rows[]|select((.gamma_outcomePrices_yes - .clob_midpoint)|fabs < 1e-12)]|length' $R/CALIBRATION.json)" "15"
chk "calibration row count"                "$(jq '.rows|length' $R/CALIBRATION.json)" "15"
chk "buckets where mid differs from lastTrade" \
    "$(jq '[.rows[]|select(.gamma_lastTradePrice != null and ((.gamma_lastTradePrice - .clob_midpoint)|fabs) > 1e-12)]|length' $R/CALIBRATION.json)" "15"
chk "mid inside [buy,sell] on all buckets" \
    "$(jq '[.rows[]|select(.clob_buy <= .clob_midpoint and .clob_midpoint <= .clob_sell)]|length' $R/CALIBRATION.json)" "15"

echo "== Q4: semantics =="
chk "markets where yes+no != 1 (must be 0)" \
    "$(jq '[.[]|select(.title|test("Fed Decision in (October|December|January)"))|.markets[]|(.outcomePrices|fromjson)|select(((.[0]|tonumber)+(.[1]|tonumber)) != 1)]|length' $R/01-events-fomc-limit100.json)" "0"
chk "October probability sum (x10000)"     "$(jq '[.[]|select(.title|test("Fed Decision in October"))|.markets[]|(.outcomePrices|fromjson|.[0]|tonumber)]|add*10000|round' $R/01-events-fomc-limit100.json)" "9985"
chk "December probability sum (x10000)"    "$(jq '[.[]|select(.title|test("Fed Decision in December"))|.markets[]|(.outcomePrices|fromjson|.[0]|tonumber)]|add*10000|round' $R/01-events-fomc-limit100.json)" "10155"
chk "January probability sum (x10000)"     "$(jq '[.[]|select(.title|test("Fed Decision in January"))|.markets[]|(.outcomePrices|fromjson|.[0]|tonumber)]|add*10000|round' $R/01-events-fomc-limit100.json)" "10155"
chk "resolved: active stays true"          "$(jq -r '.[]|select(.title=="Fed Decision in July?")|.active' $R/03-events-fomc-closed-incl.json)" "true"
chk "resolved: closed becomes true"        "$(jq -r '.[]|select(.title=="Fed Decision in July?")|.closed' $R/03-events-fomc-closed-incl.json)" "true"
chk "resolved: bestBid is null"            "$(jq -r '.[]|select(.title=="Fed Decision in July?")|.markets[0].bestBid' $R/03-events-fomc-closed-incl.json)" "null"
chk "resolved: bestAsk residual present"   "$(jq -r '.[]|select(.title=="Fed Decision in July?")|.markets[0].bestAsk' $R/03-events-fomc-closed-incl.json)" "0.001"
chk "resolved: acceptingOrders false"      "$(jq -r '.[]|select(.title=="Fed Decision in July?")|.markets[0].acceptingOrders' $R/03-events-fomc-closed-incl.json)" "false"
chk "open: acceptingOrders true"           "$(jq -r '.[]|select(.title|test("Fed Decision in October"))|.markets[0].acceptingOrders' $R/01-events-fomc-limit100.json)" "true"
chk "event level has no acceptingOrders"   "$(jq -r '.[0]|has("acceptingOrders")' $R/01-events-fomc-limit100.json)" "false"
chk "resolution text: rounded up to 25"    "$(jq -r '[.[]|select(.title|test("Fed Decision in October"))|.description|test("rounded up to the nearest 25")]|all' $R/01-events-fomc-limit100.json)" "true"
chk "resolution text: no-statement => No change" \
    "$(jq -r '[.[]|select(.title|test("Fed Decision in October"))|.description|test("resolve to the .No change. bracket")]|all' $R/01-events-fomc-limit100.json)" "true"

echo "== Q5: rate limiting / failure shapes =="
chk "gamma burst non-200 count"            "$(awk '{split($3,a,":"); if(a[1]!="200") c++} END{print c+0}' $R/RATE-LIMIT-LOG.txt)" "1"
chk "gamma burst 429 count"                "$(awk '{split($3,a,":"); if(a[1]=="429") c++} END{print c+0}' $R/RATE-LIMIT-LOG.txt)" "0"
chk "clob burst all 200"                   "$(awk '{split($3,a,":"); if(a[1]=="200") c++} END{print c+0}' $R/RATE-LIMIT-CLOB-LOG.txt)" "30"
chk "no ratelimit headers observed"        "$(grep -ci 'ratelimit\|retry-after' $R/RATE-LIMIT-LOG.txt $R/FETCH-LOG.txt 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" "0"

echo
echo "-------------------------------------------"
printf "PASS=%d FAIL=%d\n" "$pass" "$fail"
[ "$fail" -eq 0 ] && echo "ALL CLAIMS VERIFIED against committed raw/" || echo "SOME CLAIMS FAILED"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
