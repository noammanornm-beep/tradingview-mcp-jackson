import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('../node_modules/ws/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3737;
const CDP_PORT = 9222;

// ── Open symbol in TradingView Desktop via CDP ────────────────────────────
function cdpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: CDP_PORT, path }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('CDP parse error')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        ws.close();
        if (msg.result && msg.result.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.text || 'CDP eval error'));
        } else {
          resolve(msg.result);
        }
      }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 8000);
  });
}

async function openSymbolInTradingView(ticker) {
  const targets = await cdpGet('/json');
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('No TradingView page found via CDP');

  // TradingView exposes activeChart().setSymbol() on the global tvWidget
  const expr = `
    (function() {
      try {
        var widget = window.tvWidget || (window.TradingView && TradingView.chart && TradingView.chart());
        if (widget && widget.activeChart) {
          widget.activeChart().setSymbol('${ticker.replace(/'/g, '')}', function(){});
          return 'ok:widget';
        }
        // Fallback: use the URL-based navigation
        var iframe = document.querySelector('iframe[id*="tradingview"]');
        if (iframe && iframe.contentWindow && iframe.contentWindow.tvWidget) {
          iframe.contentWindow.tvWidget.activeChart().setSymbol('${ticker.replace(/'/g, '')}', function(){});
          return 'ok:iframe';
        }
        return 'not_found';
      } catch(e) { return 'err:' + e.message; }
    })()
  `;
  const result = await cdpEval(target.webSocketDebuggerUrl, expr);
  const val = result?.result?.value || '';
  if (val.startsWith('err:') || val === 'not_found') {
    throw new Error('Could not set symbol: ' + val);
  }
  return val;
}

function scannerFetch(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'scanner.tradingview.com',
      path: '/america/scan',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse error: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function buildFilters(minMcap, minPrice) {
  const filters = [];
  if (minMcap > 0)  filters.push({ left: 'market_cap_basic', operation: 'greater', right: minMcap });
  if (minPrice > 0) filters.push({ left: 'close', operation: 'greater', right: minPrice });
  return filters;
}

async function getIndustryPerformance(minMcap = 0, minPrice = 0) {
  const result = await scannerFetch({
    filter: buildFilters(minMcap, minPrice),
    columns: ['name', 'industry', 'sector', 'market_cap_basic', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M'],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, 10000],
  });

  // Aggregate by industry using market-cap-weighted average
  const industries = {};
  for (const row of result.data) {
    const [name, industry, sector, mcap, change1d, perfW, perf1M, perf3M] = row.d;
    if (!industry) continue;
    if (!industries[industry]) {
      industries[industry] = { industry, sector, totalMcap: 0, w1d: 0, w1w: 0, w1m: 0, w3m: 0, count: 0 };
    }
    const weight = mcap || 0;
    industries[industry].totalMcap += weight;
    industries[industry].w1d += (change1d || 0) * weight;
    industries[industry].w1w += (perfW || 0) * weight;
    industries[industry].w1m += (perf1M || 0) * weight;
    industries[industry].w3m += (perf3M || 0) * weight;
    industries[industry].count++;
  }

  return Object.values(industries).map(ind => ({
    industry: ind.industry,
    sector: ind.sector,
    count: ind.count,
    perf1d: ind.totalMcap ? +(ind.w1d / ind.totalMcap).toFixed(2) : 0,
    perf1w: ind.totalMcap ? +(ind.w1w / ind.totalMcap).toFixed(2) : 0,
    perf1m: ind.totalMcap ? +(ind.w1m / ind.totalMcap).toFixed(2) : 0,
    perf3m: ind.totalMcap ? +(ind.w3m / ind.totalMcap).toFixed(2) : 0,
  })).sort((a, b) => b.perf1d - a.perf1d);
}

async function getStocksForIndustry(industry, minMcap = 0, minPrice = 0) {
  const filters = [
    { left: 'industry', operation: 'equal', right: industry },
    ...buildFilters(minMcap, minPrice),
  ];
  const result = await scannerFetch({
    filter: filters,
    columns: ['name', 'description', 'industry', 'sector', 'market_cap_basic', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'close'],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, 500],
  });
  return result.data.map(row => {
    const [ticker, name, industry, sector, mcap, change1d, perfW, perf1M, perf3M, close] = row.d;
    return { ticker, name, industry, sector, mcap, perf1d: change1d, perf1w: perfW, perf1m: perf1M, perf3m: perf3M, close };
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/industries') {
    const minMcap  = parseFloat(url.searchParams.get('minMcap'))  || 0;
    const minPrice = parseFloat(url.searchParams.get('minPrice')) || 0;
    try {
      const data = await getIndustryPerformance(minMcap, minPrice);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/stocks') {
    const industry = url.searchParams.get('industry');
    const minMcap  = parseFloat(url.searchParams.get('minMcap'))  || 0;
    const minPrice = parseFloat(url.searchParams.get('minPrice')) || 0;
    if (!industry) { res.writeHead(400); res.end(JSON.stringify({ error: 'industry param required' })); return; }
    try {
      const data = await getStocksForIndustry(industry, minMcap, minPrice);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/open') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) { res.writeHead(400); res.end(JSON.stringify({ error: 'ticker param required' })); return; }
    try {
      await openSymbolInTradingView(ticker);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ticker }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve the HTML dashboard
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Industry Dashboard running at http://localhost:${PORT}\n`);
});
