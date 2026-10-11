#!/usr/bin/env node
// Polymarket FOMC-decision discovery rule — Phase 0 spike reference implementation.
//
// Answers: "given any date, how do we stably enumerate the FOMC decision bracket markets?"
//
// Layered rule (each layer is logged so the evidence is auditable):
//   L0 fetch    GET gamma /events?series_id=35   (the canonical FOMC decision series)
//               cross-check GET /events?tag_slug=fomc
//   L1 series   keep events that really carry series[].id === 35 in the embedded series array
//               (seriesSlug alone is stale on pre-2026 events; see EVIDENCE.md Q1)
//   L2 title    keep events whose title matches a known decision title shape
//   L3 shape    keep events that look like a bracket market (negRisk + 4..6 markets)
//   L4 noise    drop anything matching the known noise list (defence in depth)
//   L5 dedupe   one row per event id, then endDate ascending
//
// Usage:
//   node probe-discovery.mjs              # upcoming (open) meetings only
//   node probe-discovery.mjs --all        # whole series history, incl. resolved
//   node probe-discovery.mjs --tag        # use tag_slug=fomc instead of series_id (comparison)
//   node probe-discovery.mjs --self-test  # assert the rule on the 2026-10/12 + 2027-01 meetings
//
// Read-only public API. No key, no order/trade endpoints.

const UA = 'Mozilla/5.0';
const GAMMA = 'https://gamma-api.polymarket.com';
const SERIES_ID = '35'; // FOMC decision series

// Observed noise inside tag_slug=fomc (2026-10-11). L1 already excludes all of it; this
// list is defence in depth and documents the failure mode of "tag + title" discovery.
export const NOISE = [
  'how-many-fed-rate-hikes-in-2026',
  'warsh-out-as-fed-chair-by',
  'trump-tries-to-fire-warsh-in-2026',
  'fed-decisions-',                  // fed-3-parlay parlays: fed-decisions-sepdec / oct-jan
  'no-change-or-hike-25-bps-favored-on-october-27',
  'fed-rate-hike-by',
  'what-will-be-the-next-fed-rate-change',
  'dissent-at-fed-meeting',
  'powell-bingo',
  'what-will-powell-say',
  'what-will-kevin-warsh-say',
  'powell-says-',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

// Two title shapes are in use across the series life:
//   modern (2024-12 ->):  "Fed decision in October?" / "Fed Decision in January?"
//   legacy (2022-03 ->):  "Fed Interest Rates: June 2024" / "Fed Interest Rates March 2022"
const TITLE_MODERN = new RegExp(`^Fed decision in (${MONTHS.join('|')})\\?$`, 'i');
const TITLE_LEGACY = new RegExp(`^Fed Interest Rates:? (${MONTHS.join('|')}) \\d{4}$`, 'i');
const isDecisionTitle = (t) => TITLE_MODERN.test(t) || TITLE_LEGACY.test(t);

// Canonical bucket key. Labels drift in case ("No change" vs "No Change").
function canonicalBucket(label) {
  const s = String(label || '').trim();
  if (/^no change$/i.test(s)) return { key: 'no_change', bps: 0 };
  const m = /^(\d+)\+? bps (decrease|increase)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const up = /increase/i.test(m[2]);
    return { key: `${up ? 'inc' : 'dec'}_${m[1]}${s.includes('+') ? 'plus' : ''}`, bps: up ? n : -n };
  }
  return { key: `raw:${s}`, bps: null };
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function hasSeries(event, id) {
  return ((event.series || []).map((s) => String(s.id))).includes(String(id));
}

async function fetchCandidates({ includeClosed, useTag }) {
  const urls = useTag
    ? [`${GAMMA}/events?tag_slug=fomc&limit=100` + (includeClosed ? '' : '&closed=false')]
    : [`${GAMMA}/events?series_id=${SERIES_ID}&limit=100` + (includeClosed ? '' : '&closed=false')];
  const batches = await Promise.all(urls.map(getJSON));
  const byId = new Map();
  for (const batch of batches) for (const ev of batch) byId.set(String(ev.id), ev);
  return [...byId.values()];
}

export function applyRule(events) {
  const layers = { L0: events.length, L1: 0, L2: 0, L3: 0, L4: 0 };
  const dropped = { series: [], title: [], shape: [], noise: [] };

  const l1 = events.filter((ev) => {
    const ok = hasSeries(ev, SERIES_ID);
    if (!ok) dropped.series.push(ev.title);
    return ok;
  });
  layers.L1 = l1.length;

  const l2 = l1.filter((ev) => {
    const ok = isDecisionTitle(String(ev.title || ''));
    if (!ok) dropped.title.push(ev.title);
    return ok;
  });
  layers.L2 = l2.length;

  const l3 = l2.filter((ev) => {
    const n = (ev.markets || []).length;
    const ok = ev.negRisk === true && n >= 4 && n <= 6;
    if (!ok) dropped.shape.push(`${ev.title} (negRisk=${ev.negRisk}, n=${n})`);
    return ok;
  });
  layers.L3 = l3.length;

  const l4 = l3.filter((ev) => {
    const hay = `${ev.slug} ${ev.ticker}`;
    const hit = NOISE.find((n) => hay.includes(n));
    if (hit) dropped.noise.push(`${ev.title} <- ${hit}`);
    return !hit;
  });
  layers.L4 = l4.length;

  // L5 dedupe by event id, then endDate ascending.
  const byId = new Map();
  for (const ev of l4) byId.set(String(ev.id), ev);
  const meetings = [...byId.values()]
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
    .map((ev) => ({
      id: String(ev.id),
      slug: ev.slug,
      title: ev.title,
      seriesSlug: ev.seriesSlug,
      endDate: ev.endDate,
      closed: ev.closed,
      active: ev.active,
      buckets: (ev.markets || []).map((m) => {
        const c = canonicalBucket(m.groupItemTitle);
        return {
          label: m.groupItemTitle,
          key: c.key,
          bps: c.bps,
          yes: Number(JSON.parse(m.outcomePrices)[0]),
          bestBid: m.bestBid,
          bestAsk: m.bestAsk,
          tick: m.orderPriceMinTickSize,
          closed: m.closed,
          acceptingOrders: m.acceptingOrders,
        };
      }).sort((a, b) => (a.bps ?? 0) - (b.bps ?? 0)),
    }));

  for (const m of meetings) {
    m.probSum = Number(m.buckets.reduce((s, b) => s + b.yes, 0).toFixed(6));
    m.probSumDeviation = Number((m.probSum - 1).toFixed(6));
  }
  return { layers, dropped, meetings };
}

function printMeetings(meetings) {
  for (const m of meetings) {
    console.log(`\n${m.title}  [${m.endDate}]  slug=${m.slug}`);
    console.log(`  series=${m.seriesSlug} closed=${m.closed} buckets=${m.buckets.length}` +
                ` sum=${m.probSum} dev=${m.probSumDeviation >= 0 ? '+' : ''}${m.probSumDeviation}`);
    for (const b of m.buckets) {
      console.log(`    ${String(b.label).padEnd(18)} ${String(b.yes).padEnd(8)}` +
                  ` bid=${b.bestBid} ask=${b.bestAsk} tick=${b.tick} accepting=${b.acceptingOrders}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const includeClosed = argv.includes('--all');
  const useTag = argv.includes('--tag');
  const selfTest = argv.includes('--self-test');

  const events = await fetchCandidates({ includeClosed, useTag });
  const { layers, dropped, meetings } = applyRule(events);

  console.log(`source=${useTag ? 'tag_slug=fomc' : `series_id=${SERIES_ID}`}` +
              `${includeClosed ? ' (closed+open)' : ' (closed=false)'} candidates=${layers.L0}`);
  console.log(`layers: L0=${layers.L0} -> L1 series=${layers.L1} -> L2 title=${layers.L2}` +
              ` -> L3 shape=${layers.L3} -> L4 noise=${layers.L4}`);
  if (dropped.series.length) console.log(`  dropped@L1: ${dropped.series.join(' | ')}`);
  if (dropped.title.length) console.log(`  dropped@L2: ${dropped.title.join(' | ')}`);
  if (dropped.shape.length) console.log(`  dropped@L3: ${dropped.shape.join(' | ')}`);
  if (dropped.noise.length) console.log(`  dropped@L4: ${dropped.noise.join(' | ')}`);

  const shown = includeClosed ? meetings : meetings.filter((m) => !m.closed);
  printMeetings(shown);
  console.log(`\nmeetings matched: ${meetings.length} (shown ${shown.length})`);

  if (selfTest) {
    // Acceptance: correct bracket set for meetings after 2026-10, i.e. 2026-10/12 + 2027-01.
    const expect = {
      'Fed Decision in October?': ['dec_50plus', 'dec_25', 'no_change', 'inc_25', 'inc_50plus'],
      'Fed Decision in December?': ['dec_50plus', 'dec_25', 'no_change', 'inc_25', 'inc_50plus'],
      'Fed Decision in January?': ['dec_50plus', 'dec_25', 'no_change', 'inc_25', 'inc_50plus'],
    };
    let fail = 0;
    for (const [title, want] of Object.entries(expect)) {
      const m = meetings.find((x) => x.title === title);
      if (!m) { console.log(`SELF-TEST FAIL: ${title} not discovered`); fail++; continue; }
      const got = m.buckets.map((b) => b.key);
      const ok = JSON.stringify(got) === JSON.stringify(want);
      console.log(`SELF-TEST ${ok ? 'PASS' : 'FAIL'}: ${title} keys=${got.join(',')}`);
      if (!ok) { console.log(`  expected: ${want.join(',')}`); fail++; }
      if (!(m.probSum > 0.9 && m.probSum < 1.1)) {
        console.log(`  SELF-TEST FAIL: ${title} probSum=${m.probSum} outside sanity band`); fail++;
      }
    }
    console.log(fail === 0 ? '\nSELF-TEST: ALL PASS' : `\nSELF-TEST: ${fail} FAILURE(S)`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
}
