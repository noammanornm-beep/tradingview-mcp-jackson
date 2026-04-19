/**
 * logger.js
 * Scheduled daily data collection for Small Cap Trader.
 *
 * Schedule (US Eastern Time):
 *   08:00 → premarket   — early gappers, pre-market movers
 *   09:35 → open        — first 5 min settled, high RVol movers
 *   16:05 → eod         — final OHLCV, confirmed day stats
 *   19:00 → postmarket  — after-hours movers, continuation candidates for tomorrow
 *
 * Run as scheduler:   node logger.js
 * Manual scan:        node logger.js --scan premarket|open|eod|postmarket
 * Continuation check: node logger.js --continuations
 */

import { runScan }   from './scanner.js';
import { saveScan, loadScan, listDates } from './db.js';
import { analyzeContinuations } from './continuations.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEDULE = [
  { session: 'premarket',  hour: 8,  minute: 0  },
  { session: 'open',       hour: 9,  minute: 35 },
  { session: 'eod',        hour: 16, minute: 5  },
  { session: 'postmarket', hour: 19, minute: 0  },
];

// Skip weekends
function isTradingDay() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return !['Sat', 'Sun'].includes(day);
}

function nowET() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

function secondsUntilNext(hour, minute) {
  const now    = nowET();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let diff = (target - now) / 1000;
  if (diff < 0) diff += 86400; // schedule for next day
  return diff;
}

function fmtNum(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

function logBanner(session) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  📊 ${session.toUpperCase()} SCAN — ${new Date().toISOString()}`);
  console.log(`${line}`);
}

async function doScan(session) {
  if (!isTradingDay() && session !== 'manual') {
    console.log(`[${session}] Skipping — weekend / non-trading day.`);
    return null;
  }

  logBanner(session);
  try {
    const stocks = await runScan(session);
    const record = saveScan(session, stocks);

    if (stocks.length === 0) {
      console.log(`[${session}] No stocks matched filters (market may be closed).`);
      return record;
    }

    console.log(`\n✅ ${stocks.length} stocks saved.\n`);

    // Print top 10 by RVol with catalyst flags
    const top = [...stocks].sort((a,b)=>(b.rvol||0)-(a.rvol||0)).slice(0,10);
    console.log('  #  TICKER   PRICE     CHG%     VOL       RVOL   FLOAT     CATALYSTS');
    console.log('  ' + '─'.repeat(70));
    top.forEach((s, i) => {
      const cats = s.catalysts?.length ? s.catalysts.map(c=>c.toUpperCase()).join(' ') : '';
      console.log(
        `  ${String(i+1).padStart(2)}. ${(s.ticker||'').padEnd(7)} ` +
        `$${String((s.price||0).toFixed(2)).padStart(7)}  ` +
        `${s.change_pct!=null?(s.change_pct>0?'+':'')+s.change_pct.toFixed(2)+'%':'  —  '.padStart(7)}  ` +
        `${fmtNum(s.volume).padStart(8)}  ` +
        `${s.rvol?s.rvol.toFixed(1)+'×':'—'.padStart(5)}  ` +
        `${fmtNum(s.float_shares).padStart(8)}  ` +
        `${cats}`
      );
    });

    // After postmarket scan: run continuation analysis for tomorrow
    if (session === 'postmarket') {
      console.log('\n🔁 Running continuation analysis…');
      await analyzeContinuations();
    }

    return record;
  } catch (e) {
    console.error(`[${session}] ❌ Error: ${e.message}`);
    return null;
  }
}

function scheduleAll() {
  console.log('\n┌─────────────────────────────────────────────────────┐');
  console.log('│         Small Cap Trader — Auto Logger               │');
  console.log('│         Float ≤ 10M · Price ≥ $0.20 · Vol ≥ 200K   │');
  console.log('└─────────────────────────────────────────────────────┘');
  console.log('\n📅 Scheduled scans (US Eastern Time):');

  for (const { session, hour, minute } of SCHEDULE) {
    const secs = secondsUntilNext(hour, minute);
    const hms  = new Date(secs * 1000).toISOString().slice(11, 19);
    const label = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} ET`;
    const desc = { premarket:'Gappers & early movers', open:'High RVol at open', eod:'Final OHLCV snapshot', postmarket:'After-hours + continuations' };
    console.log(`  ${session.padEnd(12)} ${label}  (in ${hms})  — ${desc[session]}`);

    setTimeout(async function runAndReschedule() {
      await doScan(session);
      setTimeout(runAndReschedule, 86400 * 1000);
    }, secs * 1000);
  }

  console.log('\n✅ Logger running. Press Ctrl+C to stop.\n');
}

// ── Entry point ─────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const scanIdx    = args.indexOf('--scan');
const contFlag   = args.includes('--continuations');

if (contFlag) {
  await analyzeContinuations();
  process.exit(0);
} else if (scanIdx !== -1) {
  const session = args[scanIdx + 1];
  if (!['premarket','open','eod','postmarket'].includes(session)) {
    console.error('Usage: node logger.js --scan premarket|open|eod|postmarket');
    process.exit(1);
  }
  await doScan(session);
  process.exit(0);
} else {
  scheduleAll();
}
