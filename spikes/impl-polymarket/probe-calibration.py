#!/usr/bin/env python3
"""Polymarket probability-caliber calibration — Phase 0 spike, Q2 evidence.

Compares, for every bracket of the three upcoming FOMC decision meetings:
  gamma outcomePrices[0]  (Yes leg)         <- what the events API shows
  CLOB /midpoint                            <- (bestBid+bestAsk)/2
  CLOB /price side=buy | side=sell          <- bestBid / bestAsk
  gamma lastTradePrice                      <- last executed trade

Answers: which is the display caliber, and what does "mid instead of last trade" cost?

Read-only public API, UA required (see EVIDENCE.md Q0). No order/trade endpoints.

usage: python3 probe-calibration.py [--save raw/CALIBRATION.json]
"""
import json, sys, time, urllib.request

UA = {"User-Agent": "Mozilla/5.0"}
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
MEETINGS = ("October", "December", "January")


def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers=UA)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read())


def main():
    save = "--save" in sys.argv
    # Cache-bust so we compare live gamma against live CLOB, not a 5-minute CDN copy.
    _, events = get(f"{GAMMA}/events?tag_slug=fomc&closed=false&limit=100&_cb={time.time_ns()}")

    rows = []
    for ev in events:
        if not any(f"Fed Decision in {m}" in ev.get("title", "") for m in MEETINGS):
            continue
        for m in ev["markets"]:
            tok = json.loads(m["clobTokenIds"])[0]
            gp = float(json.loads(m["outcomePrices"])[0])
            _, mid = get(f"{CLOB}/midpoint?token_id={tok}")
            _, buy = get(f"{CLOB}/price?token_id={tok}&side=buy")
            _, sell = get(f"{CLOB}/price?token_id={tok}&side=sell")
            rows.append({
                "meeting": ev["title"],
                "bucket": m["groupItemTitle"],
                "outcomes": ev.get("outcomes"),
                "gamma_outcomePrices_yes": gp,
                "clob_midpoint": float(mid["mid"]),
                "clob_buy": float(buy["price"]),
                "clob_sell": float(sell["price"]),
                "gamma_bestBid": m["bestBid"],
                "gamma_bestAsk": m["bestAsk"],
                "gamma_lastTradePrice": m["lastTradePrice"],
                "gamma_tick": m["orderPriceMinTickSize"],
                "gamma_updatedAt": m["updatedAt"],
            })

    print(f"{'meeting':10s} {'bucket':18s} {'gamma':>8s} {'clobMid':>8s} {'d':>7s} "
          f"{'buy':>7s} {'sell':>7s} {'last':>7s} {'tick':>6s}")
    for r in rows:
        d = r["gamma_outcomePrices_yes"] - r["clob_midpoint"]
        print(f"{r['meeting'][16:25]:10s} {r['bucket']:18s} "
              f"{r['gamma_outcomePrices_yes']:8.4f} {r['clob_midpoint']:8.4f} {d:7.4f} "
              f"{r['clob_buy']:7.4f} {r['clob_sell']:7.4f} "
              f"{(r['gamma_lastTradePrice'] or 0):7.4f} {r['gamma_tick']:6.3f}")

    n = len(rows)
    exact = sum(1 for r in rows
                if abs(r["gamma_outcomePrices_yes"] - r["clob_midpoint"]) < 1e-12)
    maxd = max(abs(r["gamma_outcomePrices_yes"] - r["clob_midpoint"]) for r in rows)

    # mid vs last trade
    lt = [r for r in rows if r["gamma_lastTradePrice"] is not None]
    ltd = [abs(r["gamma_lastTradePrice"] - r["clob_midpoint"]) for r in lt]
    # mid vs the bid/ask you would actually cross
    spread = [r["clob_sell"] - r["clob_buy"] for r in rows]

    # per-meeting probability sum
    print()
    for ev in sorted({r["meeting"] for r in rows}):
        sub = [r for r in rows if r["meeting"] == ev]
        s = sum(r["gamma_outcomePrices_yes"] for r in sub)
        sb = sum(r["clob_buy"] for r in sub)
        sa = sum(r["clob_sell"] for r in sub)
        print(f"{ev:26s} n={len(sub)} sum(mid)={s:.6f} dev={s-1:+.4f} "
              f"sum(buy)={sb:.4f} sum(sell)={sa:.4f}")

    print()
    print(f"Q2 RESULT: gamma outcomePrices == CLOB midpoint on {exact}/{n} buckets "
          f"(max abs diff {maxd})")
    print(f"  mid vs lastTradePrice: {sum(1 for d in ltd if d > 1e-12)}/{len(lt)} buckets differ, "
          f"mean |diff|={sum(ltd)/len(ltd):.4f}, max={max(ltd):.4f}")
    print(f"  mid sits inside [buy,sell]: "
          f"{sum(1 for r in rows if r['clob_buy'] <= r['clob_midpoint'] <= r['clob_sell'])}/{n}")
    print(f"  mean spread={sum(spread)/len(spread):.4f}, max={max(spread):.4f}")

    if save:
        with open("raw/CALIBRATION.json", "w") as f:
            json.dump({"fetched_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "rows": rows}, f, indent=2)
        print("saved raw/CALIBRATION.json")


if __name__ == "__main__":
    main()
