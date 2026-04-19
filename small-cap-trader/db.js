/**
 * db.js
 * Simple file-based database.
 * Stores daily scan results as JSON files organized by date:
 *
 *   data/
 *     2026-04-19/
 *       premarket.json
 *       open.json
 *       eod.json
 *     2026-04-20/
 *       ...
 *
 * Each file is an array of stock objects from that scan.
 * Also maintains a summary index: data/index.json
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Save a scan result to disk */
export function saveScan(session, stocks) {
  const date    = todayStr();
  const dateDir = path.join(DATA_DIR, date);
  ensureDir(dateDir);

  const file = path.join(dateDir, `${session}.json`);
  const record = {
    session,
    date,
    scanned_at: new Date().toISOString(),
    count: stocks.length,
    stocks,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  // Update index
  updateIndex(date, session, stocks.length);

  console.log(`[DB] Saved ${stocks.length} stocks → data/${date}/${session}.json`);
  return record;
}

function updateIndex(date, session, count) {
  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch {}
  }
  if (!index[date]) index[date] = {};
  index[date][session] = { count, saved_at: new Date().toISOString() };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

/** Load a specific scan */
export function loadScan(date, session) {
  const file = path.join(DATA_DIR, date, `${session}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** List all available scan dates */
export function listDates() {
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return Object.entries(index)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, sessions]) => ({ date, sessions }));
    } catch {}
  }
  // Fallback: scan directories
  ensureDir(DATA_DIR);
  return fs.readdirSync(DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort().reverse()
    .map(date => ({ date, sessions: {} }));
}

/** Get stats across all saved data for a ticker */
export function getTickerHistory(ticker) {
  const dates = listDates();
  const history = [];
  for (const { date } of dates) {
    for (const session of ['premarket', 'open', 'eod']) {
      const scan = loadScan(date, session);
      if (!scan) continue;
      const stock = scan.stocks.find(s => s.ticker === ticker);
      if (stock) history.push(stock);
    }
  }
  return history;
}

/** Get all tickers that have appeared across all scans */
export function getAllTickers() {
  const dates  = listDates();
  const counts = {};
  for (const { date } of dates) {
    for (const session of ['premarket', 'open', 'eod']) {
      const scan = loadScan(date, session);
      if (!scan) continue;
      for (const s of scan.stocks) {
        if (!counts[s.ticker]) counts[s.ticker] = { ticker: s.ticker, name: s.name, appearances: 0, dates: new Set() };
        counts[s.ticker].appearances++;
        counts[s.ticker].dates.add(date);
      }
    }
  }
  return Object.values(counts).map(t => ({ ...t, days: t.dates.size, dates: [...t.dates].sort().reverse() }))
    .sort((a, b) => b.appearances - a.appearances);
}
