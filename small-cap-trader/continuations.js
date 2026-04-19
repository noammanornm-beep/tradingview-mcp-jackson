/**
 * continuations.js
 * Analyzes post-market movers and flags continuation candidates for next day.
 * Also retrospectively scores how previous continuation candidates performed.
 *
 * A "continuation candidate" is a stock that:
 *   - Appeared in postmarket scan
 *   - Had significant move (|change_pct| >= 5% OR rvol >= 3)
 *   - We then track: did it continue at next day's open and EOD?
 *
 * Saved to: data/YYYY-MM-DD/continuations.json
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadScan, listDates } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, 'data');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function nextTradingDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); }
  while ([0, 6].includes(d.getUTCDay())); // skip Sat/Sun
  return d.toISOString().slice(0, 10);
}

function prevTradingDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); }
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

/**
 * After postmarket scan: flag candidates for tomorrow.
 */
export async function analyzeContinuations() {
  const dates = listDates();
  if (!dates.length) return;

  const today    = dates[0].date;
  const tomorrow = nextTradingDate(today);

  const pmScan = loadScan(today, 'postmarket');
  if (!pmScan || !pmScan.stocks.length) {
    console.log('[Continuations] No postmarket data for today yet.');
    return;
  }

  // Filter for meaningful postmarket movers
  const candidates = pmScan.stocks.filter(s =>
    Math.abs(s.change_pct || 0) >= 5 || (s.rvol || 0) >= 3
  ).map(s => ({
    ticker:       s.ticker,
    name:         s.name,
    exchange:     s.exchange,
    float_shares: s.float_shares,
    catalysts:    s.catalysts || [],
    // Postmarket snapshot
    pm_price:     s.price,
    pm_change:    s.change_pct,
    pm_gap:       s.gap_pct,
    pm_rvol:      s.rvol,
    pm_volume:    s.volume,
    pm_high:      s.high,
    pm_low:       s.low,
    pm_scanned:   s.scanned_at,
    // To be filled in tomorrow
    next_date:    tomorrow,
    next_open:    null,
    next_high:    null,
    next_low:     null,
    next_close:   null,
    next_rvol:    null,
    next_chg:     null,
    continued:    null,   // true/false/null (pending)
    continuation_score: null,
  }));

  const record = {
    date:          today,
    next_date:     tomorrow,
    generated_at:  new Date().toISOString(),
    candidate_count: candidates.length,
    candidates,
  };

  const dir  = path.join(DATA_DIR, today);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'continuations.json'), JSON.stringify(record, null, 2));
  console.log(`[Continuations] ${candidates.length} candidates saved for ${tomorrow}.`);
  candidates.slice(0, 5).forEach(c =>
    console.log(`  → ${c.ticker.padEnd(7)} PM chg: ${c.pm_change?.toFixed(2)}%  RVol: ${c.pm_rvol?.toFixed(1)}×  Catalysts: ${c.catalysts.join(',')||'—'}`)
  );

  // Also score yesterday's candidates if we now have today's data
  await scorePreviousCandidates(today);
}

/**
 * Once we have today's open/eod data, score yesterday's continuation candidates.
 */
async function scorePreviousCandidates(today) {
  const yesterday = prevTradingDate(today);
  const contFile  = path.join(DATA_DIR, yesterday, 'continuations.json');
  if (!fs.existsSync(contFile)) return;

  let record;
  try { record = JSON.parse(fs.readFileSync(contFile, 'utf8')); } catch { return; }
  if (record.next_date !== today) return;

  const openScan = loadScan(today, 'open');
  const eodScan  = loadScan(today, 'eod');
  if (!openScan && !eodScan) return;

  const openMap = {};
  const eodMap  = {};
  (openScan?.stocks || []).forEach(s => openMap[s.ticker] = s);
  (eodScan?.stocks  || []).forEach(s => eodMap[s.ticker]  = s);

  let scored = 0;
  record.candidates = record.candidates.map(c => {
    const o = openMap[c.ticker];
    const e = eodMap[c.ticker];
    if (!o && !e) return c;

    const next_open  = o?.open  || o?.price || null;
    const next_high  = e?.high  || o?.high  || null;
    const next_low   = e?.low   || o?.low   || null;
    const next_close = e?.price || o?.price || null;
    const next_chg   = e?.change_pct || o?.change_pct || null;
    const next_rvol  = e?.rvol  || o?.rvol  || null;

    // Continuation = same direction move of ≥ 3% at open OR positive eod close
    const pm_bullish  = (c.pm_change || 0) >= 0;
    const continued   = next_chg != null
      ? (pm_bullish ? next_chg >= 3 : next_chg <= -3)
      : null;

    // Score 0–100: direction match + magnitude + rvol
    let score = 0;
    if (continued === true)  score += 50;
    if (next_chg != null)    score += Math.min(30, Math.abs(next_chg) * 3);
    if (next_rvol != null)   score += Math.min(20, next_rvol * 4);

    scored++;
    return { ...c, next_open, next_high, next_low, next_close, next_chg, next_rvol, continued, continuation_score: Math.round(score) };
  });

  record.scored_at = new Date().toISOString();
  record.scored_count = scored;
  fs.writeFileSync(contFile, JSON.stringify(record, null, 2));

  const wins = record.candidates.filter(c => c.continued === true).length;
  const total = record.candidates.filter(c => c.continued !== null).length;
  console.log(`[Continuations] Scored ${yesterday} → ${wins}/${total} continued (${total?Math.round(wins/total*100):0}% hit rate)`);
}

/** Load continuation candidates for a given date */
export function loadContinuations(date) {
  const file = path.join(DATA_DIR, date, 'continuations.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
