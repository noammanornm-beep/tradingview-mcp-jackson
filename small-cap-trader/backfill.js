/**
 * backfill.js
 * Fetches historical daily OHLCV data for small cap stocks
 * and stores them as historical scan records so pivot levels
 * can be built immediately from real data.
 *
 * Data source: Yahoo Finance (free, no auth required)
 * History: up to 6 months of daily bars
 *
 * Usage:
 *   node backfill.js                    -- backfill all tickers from latest scan
 *   node backfill.js --ticker EFOI      -- single ticker
 *   node backfill.js --days 90          -- custom lookback (default 180)
 *   node backfill.js --limit 50         -- max tickers to process
 */

import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';
import { runScan }    from './scanner.js';
import { listDates, loadScan } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, 'data');

// ── Yahoo Finance OHLCV fetch ─────────────────────────────────────────────
function fetchYahooHistory(ticker, days = 180) {
  return new Promise((resolve, reject) => {
    const end   = Math.floor(Date.now() / 1000);
    const start = end - days * 86400;
    const path  = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${start}&period2=${end}&events=splits,earnings`;

    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method:  'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept':     'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const result = parsed?.chart?.result?.[0];
          if (!result) { resolve(null); return; }

          const timestamps = result.timestamps || result.timestamp || [];
          const quotes     = result.indicators?.quote?.[0] || {};
          const { open, high, low, close, volume } = quotes;

          // Extract splits
          const splits = {};
          const splitEvents = result.events?.splits || {};
          for (const ev of Object.values(splitEvents)) {
            const date = new Date(ev.date * 1000).toISOString().slice(0, 10);
            splits[date] = `${ev.numerator}:${ev.denominator}`;
          }

          // Extract earnings dates
          const earnings = {};
          const earningsEvents = result.events?.earnings || {};
          for (const ev of Object.values(earningsEvents)) {
            const date = new Date(ev.date * 1000).toISOString().slice(0, 10);
            earnings[date] = { eps_estimate: ev.epsestimate, eps_actual: ev.epsactual };
          }

          const bars = timestamps.map((ts, i) => ({
            date:   new Date(ts * 1000).toISOString().slice(0, 10),
            open:   open?.[i]   || null,
            high:   high?.[i]   || null,
            low:    low?.[i]    || null,
            close:  close?.[i]  || null,
            volume: volume?.[i] || null,
          })).filter(b => b.close !== null && b.date);

          resolve({ bars, splits, earnings, meta: result.meta });
        } catch(e) { reject(new Error('Yahoo parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Convert a Yahoo bar to our scan record format ─────────────────────────
function barToScanRecord(ticker, bar, meta, stockInfo, splits, earnings) {
  const prevClose  = null; // would need previous bar for gap calc
  const catalysts  = [];
  if (splits[bar.date])   catalysts.push('split');
  if (earnings[bar.date]) catalysts.push('earnings');

  return {
    ticker,
    name:         meta?.longName || meta?.shortName || stockInfo?.name || ticker,
    exchange:     meta?.exchangeName || stockInfo?.exchange || null,
    sector:       stockInfo?.sector   || null,
    industry:     stockInfo?.industry || null,
    stock_type:   null,
    price:        bar.close,
    open:         bar.open,
    high:         bar.high,
    low:          bar.low,
    day_high:     bar.high,
    volume:       bar.volume,
    avg_volume:   meta?.regularMarketVolume || null,
    rvol:         null,  // can't compute without avg — will be null
    change_pct:   null,  // will compute from bars in aggregate
    gap_pct:      null,
    mcap:         meta?.marketCap || stockInfo?.mcap || null,
    float_shares: stockInfo?.float_shares || null,
    short_ratio:  null,
    high52w:      meta?.fiftyTwoWeekHigh || null,
    low52w:       meta?.fiftyTwoWeekLow  || null,
    pct_of_52w_high: (bar.close && meta?.fiftyTwoWeekHigh)
      ? +((bar.close / meta.fiftyTwoWeekHigh) * 100).toFixed(1)
      : null,
    catalysts,
    earnings_date:      earnings[bar.date] ? bar.date : null,
    split_factor:       splits[bar.date]   ? splits[bar.date] : null,
    eps_ttm:            null,
    rev_growth:         null,
    keyword_match:      null,
    session:            'historical',
    scanned_at:         bar.date + 'T16:00:00.000Z', // treat as EOD
    source:             'yahoo_backfill',
  };
}

// ── Save historical records to DB ─────────────────────────────────────────
function saveHistoricalBars(ticker, bars) {
  let saved = 0;
  for (const bar of bars) {
    const dateStr = (bar.scanned_at || '').slice(0, 10);
    if (!dateStr) continue;
    const dateDir = path.join(DATA_DIR, dateStr);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const histFile = path.join(dateDir, 'historical.json');
    let existing = { session:'historical', date:dateStr, stocks:[], count:0, scanned_at: new Date().toISOString() };
    if (fs.existsSync(histFile)) {
      try { existing = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
    }

    // Replace or insert this ticker's bar
    existing.stocks = existing.stocks.filter(s => s.ticker !== ticker);
    existing.stocks.push(bar);
    existing.count  = existing.stocks.length;
    fs.writeFileSync(histFile, JSON.stringify(existing, null, 2));
    saved++;
  }

  // Update backfill index
  updateHistoricalIndex(ticker, bars.length);
  // Update main data index so listDates() finds these dates
  updateMainIndex(bars);
  return saved;
}

function updateMainIndex(bars) {
  const mainIndex = path.join(DATA_DIR, 'index.json');
  let index = {};
  if (fs.existsSync(mainIndex)) {
    try { index = JSON.parse(fs.readFileSync(mainIndex, 'utf8')); } catch {}
  }
  for (const bar of bars) {
    const dateStr = (bar.scanned_at || '').slice(0, 10);
    if (!dateStr) continue;
    if (!index[dateStr]) index[dateStr] = {};
    if (!index[dateStr].historical) {
      // Count how many stocks are in this date's historical file
      const hFile = path.join(DATA_DIR, dateStr, 'historical.json');
      let count = 0;
      if (fs.existsSync(hFile)) {
        try { count = JSON.parse(fs.readFileSync(hFile, 'utf8')).count || 0; } catch {}
      }
      index[dateStr].historical = { count, saved_at: new Date().toISOString() };
    }
  }
  fs.writeFileSync(mainIndex, JSON.stringify(index, null, 2));
}

function updateHistoricalIndex(ticker, barCount) {
  const indexFile = path.join(DATA_DIR, 'backfill-index.json');
  let index = {};
  if (fs.existsSync(indexFile)) {
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  }
  index[ticker] = { bars: barCount, updated_at: new Date().toISOString() };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
}

// ── Main backfill runner ──────────────────────────────────────────────────
export async function backfillTickers(tickers, stockInfoMap = {}, days = 180, onProgress = null) {
  const results = { success: [], failed: [], skipped: [] };
  const total   = tickers.length;

  // Check which are already backfilled
  const indexFile = path.join(DATA_DIR, 'backfill-index.json');
  let alreadyDone = {};
  if (fs.existsSync(indexFile)) {
    try { alreadyDone = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  }

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    if (onProgress) onProgress({ ticker, i: i+1, total, status: 'fetching' });
    else process.stdout.write(`  [${String(i+1).padStart(3)}/${total}] ${ticker.padEnd(7)} `);

    // Throttle — Yahoo rate limits aggressively
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));

    try {
      const data = await fetchYahooHistory(ticker, days);
      if (!data || !data.bars.length) {
        results.failed.push({ ticker, reason: 'No data returned' });
        if (!onProgress) process.stdout.write('❌ no data\n');
        continue;
      }

      // Convert bars to scan records
      const stockInfo = stockInfoMap[ticker] || {};
      const records   = [];
      const bars      = data.bars;

      // Compute day-over-day change and gap
      for (let j = 0; j < bars.length; j++) {
        const bar  = bars[j];
        const prev = bars[j-1];
        const rec  = barToScanRecord(ticker, bar, data.meta, stockInfo, data.splits, data.earnings);
        if (prev?.close && bar.close) {
          rec.change_pct = +((bar.close - prev.close) / prev.close * 100).toFixed(2);
          rec.gap_pct    = bar.open && prev.close
            ? +((bar.open - prev.close) / prev.close * 100).toFixed(2)
            : null;
        }
        records.push(rec);
      }

      const saved = saveHistoricalBars(ticker, records);
      results.success.push({ ticker, bars: saved, splits: Object.keys(data.splits).length, earnings: Object.keys(data.earnings).length });

      if (!onProgress) {
        const splitStr = Object.keys(data.splits).length ? ` ✂️ split` : '';
        const earStr   = Object.keys(data.earnings).length ? ` 📊 earnings` : '';
        process.stdout.write(`✅ ${saved} bars${splitStr}${earStr}\n`);
      }
    } catch(e) {
      results.failed.push({ ticker, reason: e.message });
      if (!onProgress) process.stdout.write(`❌ ${e.message}\n`);
    }
  }

  return results;
}

// ── Get list of tickers to backfill ──────────────────────────────────────
async function getTickersToBackfill(limit = 200) {
  // Try to get from latest scan first
  const dates = listDates().filter(d => d.sessions);
  let tickers = [];
  const stockInfoMap = {};

  for (const { date, sessions } of dates.slice(0, 5)) {
    for (const session of ['open','eod','premarket','postmarket','historical']) {
      const scan = loadScan(date, session);
      if (!scan?.stocks) continue;
      for (const s of scan.stocks) {
        if (!tickers.includes(s.ticker)) {
          tickers.push(s.ticker);
          stockInfoMap[s.ticker] = {
            name:         s.name,
            exchange:     s.exchange,
            sector:       s.sector,
            industry:     s.industry,
            mcap:         s.mcap,
            float_shares: s.float_shares,
          };
        }
      }
    }
  }

  // If no scan data yet, run a fresh scan
  if (!tickers.length) {
    console.log('No scan data found — running a fresh scan to get tickers…');
    try {
      const stocks = await runScan('open');
      for (const s of stocks) {
        tickers.push(s.ticker);
        stockInfoMap[s.ticker] = { name:s.name, exchange:s.exchange, sector:s.sector, industry:s.industry, mcap:s.mcap, float_shares:s.float_shares };
      }
      console.log(`Got ${tickers.length} tickers from live scan.\n`);
    } catch(e) {
      console.error('Live scan failed:', e.message);
    }
  }

  return { tickers: tickers.slice(0, limit), stockInfoMap };
}

// ── CLI entry point (only runs when executed directly) ────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g,'/').split('/').pop());
if (!isMain) { /* imported as module — skip CLI */ }
else {
const args       = process.argv.slice(2);
const singleIdx  = args.indexOf('--ticker');
const daysIdx    = args.indexOf('--days');
const limitIdx   = args.indexOf('--limit');

const days  = daysIdx  !== -1 ? parseInt(args[daysIdx+1])  || 180 : 180;
const limit = limitIdx !== -1 ? parseInt(args[limitIdx+1]) || 200 : 200;

if (singleIdx !== -1) {
  // Single ticker backfill
  const ticker = args[singleIdx + 1]?.toUpperCase();
  if (!ticker) { console.error('Usage: node backfill.js --ticker AAPL'); process.exit(1); }
  console.log(`\n📥 Backfilling ${ticker} (${days} days)…\n`);
  const results = await backfillTickers([ticker], {}, days);
  console.log('\nDone:', results);
} else {
  // Backfill all from scan
  console.log(`\n┌──────────────────────────────────────────────┐`);
  console.log(`│  Small Cap Backfill — Yahoo Finance History   │`);
  console.log(`│  Lookback: ${String(days).padEnd(4)} days · Max tickers: ${String(limit).padEnd(4)}│`);
  console.log(`└──────────────────────────────────────────────┘\n`);

  const { tickers, stockInfoMap } = await getTickersToBackfill(limit);
  if (!tickers.length) { console.log('No tickers to backfill.'); process.exit(0); }

  console.log(`Found ${tickers.length} tickers to backfill. Starting…\n`);
  const results = await backfillTickers(tickers, stockInfoMap, days);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Success: ${results.success.length} tickers`);
  console.log(`❌ Failed:  ${results.failed.length} tickers`);
  if (results.failed.length) {
    console.log(`   ${results.failed.map(f=>f.ticker).join(', ')}`);
  }
  const totalBars = results.success.reduce((s,r)=>s+r.bars,0);
  console.log(`📊 Total bars saved: ${totalBars.toLocaleString()}`);
}
} // end isMain
