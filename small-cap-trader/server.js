/**
 * server.js
 * API + dashboard server for small cap trader.
 * Port: process.env.PORT || 3838
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('../node_modules/ws/index.js');

import { runScan }          from './scanner.js';
import { saveScan, loadScan, listDates, getTickerHistory, getAllTickers } from './db.js';
import { loadContinuations } from './continuations.js';
import { calculatePivots, buildTVDrawCode } from './pivots.js';
import { backfillTickers } from './backfill.js';
import { getKeywordStats, addKeyword, removeKeyword, updateKeyword, recordOutcome } from './keywords.js';

const CDP_PORT = 9222;

function cdpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname:'localhost', port:CDP_PORT, path:p }, (r) => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} });
    });
    req.on('error',reject); req.end();
  });
}

async function openInTradingView(ticker) {
  const targets = await cdpGet('/json');
  const target  = targets.find(t => t.type==='page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('TradingView not connected');
  const expr = `(function(){try{var w=window.tvWidget;if(w&&w.activeChart){w.activeChart().setSymbol('${ticker.replace(/'/g,'')}',function(){});return 'ok';}return 'not_found';}catch(e){return 'err:'+e.message;}})()`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.on('open', () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:expr}})));
    ws.on('message', data => { ws.close(); resolve(JSON.parse(data)); });
    ws.on('error', reject);
    setTimeout(()=>{ ws.close(); reject(new Error('CDP timeout')); }, 8000);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3838;

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://localhost');

  // ── GET /api/scan?session=open  (manual trigger)
  if (url.pathname === '/api/scan') {
    const session = url.searchParams.get('session') || 'open';
    if (!['premarket', 'open', 'eod', 'postmarket'].includes(session)) {
      return json(res, { error: 'Invalid session. Use: premarket | open | eod | postmarket' }, 400);
    }
    try {
      const stocks = await runScan(session);
      const record = saveScan(session, stocks);
      return json(res, record);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── GET /api/dates  →  list of dates with available scans
  if (url.pathname === '/api/dates') {
    return json(res, listDates());
  }

  // ── GET /api/data?date=2026-04-19&session=open
  if (url.pathname === '/api/data') {
    const date    = url.searchParams.get('date');
    const session = url.searchParams.get('session') || 'open';
    if (!date) return json(res, { error: 'date param required' }, 400);
    const record = loadScan(date, session);
    if (!record) return json(res, { error: 'No data found for that date/session' }, 404);
    return json(res, record);
  }

  // ── GET /api/tickers  →  all tickers seen across all scans
  if (url.pathname === '/api/tickers') {
    return json(res, getAllTickers());
  }

  // ── GET /api/ticker?symbol=AAPL  →  full history for one ticker
  if (url.pathname === '/api/ticker') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return json(res, { error: 'symbol param required' }, 400);
    return json(res, getTickerHistory(symbol.toUpperCase()));
  }

  // ── GET /api/continuations?date=YYYY-MM-DD
  if (url.pathname === '/api/continuations') {
    const date = url.searchParams.get('date');
    if (!date) return json(res, { error: 'date param required' }, 400);
    const data = loadContinuations(date);
    if (!data) return json(res, { error: 'No continuation data for this date' }, 404);
    return json(res, data);
  }

  // ── Keywords API ──────────────────────────────────────────────────────────
  if (url.pathname === '/api/keywords') {
    if (req.method === 'GET') return json(res, getKeywordStats());

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { action, phrase, category, sentiment, base_score, notes, updates, move_pct, phrases } = JSON.parse(body);
          if (action === 'add')     return json(res, addKeyword(phrase, category, sentiment, base_score, notes));
          if (action === 'remove')  return json(res, removeKeyword(phrase));
          if (action === 'update')  return json(res, updateKeyword(phrase, updates));
          if (action === 'outcome') { recordOutcome(phrases, move_pct); return json(res, { success: true }); }
          return json(res, { error: 'Unknown action' }, 400);
        } catch(e) { return json(res, { error: e.message }, 400); }
      });
      return;
    }
  }

  // ── POST /api/backfill  →  fetch historical data for tickers
  if (url.pathname === '/api/backfill') {
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { tickers, days = 180 } = body ? JSON.parse(body) : {};
        if (!tickers?.length) return json(res, { error: 'tickers array required' }, 400);

        // Stream progress via SSE if requested
        const sse = req.headers.accept === 'text/event-stream';
        if (sse) {
          res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Access-Control-Allow-Origin':'*' });
          const results = await backfillTickers(tickers, {}, days, (progress) => {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ done: true, ...results })}\n\n`);
          res.end();
        } else {
          const results = await backfillTickers(tickers, {}, days);
          return json(res, results);
        }
      } catch(e) { return json(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── GET /api/backfill-status  →  check what's been backfilled
  if (url.pathname === '/api/backfill-status') {
    const indexFile = path.join(__dirname, 'data', 'backfill-index.json');
    if (!fs.existsSync(indexFile)) return json(res, {});
    try { return json(res, JSON.parse(fs.readFileSync(indexFile, 'utf8'))); }
    catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── GET /api/pivots?ticker=AAPL&price=5.50  →  calculate pivot levels
  if (url.pathname === '/api/pivots') {
    const ticker = url.searchParams.get('ticker');
    const price  = parseFloat(url.searchParams.get('price')) || null;
    if (!ticker) return json(res, { error: 'ticker required' }, 400);
    try {
      const data = calculatePivots(ticker.toUpperCase(), price);
      return json(res, data);
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── GET /api/draw-pivots?ticker=AAPL&price=5.50  →  draw pivots on TradingView chart
  if (url.pathname === '/api/draw-pivots') {
    const ticker = url.searchParams.get('ticker');
    const price  = parseFloat(url.searchParams.get('price')) || null;
    if (!ticker) return json(res, { error: 'ticker required' }, 400);
    try {
      // First switch to the ticker in TradingView
      await openInTradingView(ticker);
      await new Promise(r => setTimeout(r, 800)); // wait for chart to load

      // Calculate pivots
      const data = calculatePivots(ticker.toUpperCase(), price);
      if (!data.pivots.length) return json(res, { success: true, drawn: 0, message: 'No pivots to draw (need more scan history)' });

      // Draw via CDP
      const jsCode  = buildTVDrawCode(data.pivots, ticker);
      const targets = await cdpGet('/json');
      const target  = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!target) return json(res, { error: 'TradingView not connected' }, 500);

      const result = await new Promise((resolve, reject) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.on('open', () => ws.send(JSON.stringify({ id:1, method:'Runtime.evaluate', params:{ expression: jsCode, awaitPromise: false } })));
        ws.on('message', d => { ws.close(); resolve(JSON.parse(d)); });
        ws.on('error', reject);
        setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 10000);
      });

      const val = result?.result?.result?.value || '';
      return json(res, { success: true, drawn: data.pivots.length, ticker, cdp_result: val, pivots: data.pivots });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── GET /api/open?ticker=AAPL  →  open in TradingView Desktop
  if (url.pathname === '/api/open') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) return json(res, { error: 'ticker required' }, 400);
    try {
      await openInTradingView(ticker);
      return json(res, { success: true, ticker });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── Serve dashboard HTML
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Small Cap Trader running at http://localhost:${PORT}\n`);
  console.log('API endpoints:');
  console.log('  GET /api/scan?session=premarket|open|eod   — trigger manual scan');
  console.log('  GET /api/dates                             — list available dates');
  console.log('  GET /api/data?date=YYYY-MM-DD&session=...  — load a scan');
  console.log('  GET /api/tickers                           — all tickers ever seen');
  console.log('  GET /api/ticker?symbol=AAPL                — history for one ticker\n');
});
