/**
 * scanner.js
 * Fetches small cap stocks from TradingView scanner.
 * Definition: Float ≤ 10M shares, Price ≥ $0.20, Volume ≥ 200K, US listed only (no OTC).
 */

import https from 'https';
import { matchKeywords } from './keywords.js';

const EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'BATS'];

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

/**
 * Run the small cap scan and return normalized stock objects.
 * @param {string} session - 'premarket' | 'open' | 'eod'
 */
export async function runScan(session = 'open') {
  const result = await scannerFetch({
    filter: [
      // Float ≤ 10 million shares
      { left: 'float_shares_outstanding', operation: 'less',    right: 10000000 },
      // Price ≥ $0.20
      { left: 'close',                    operation: 'greater', right: 0.20 },
      // Volume ≥ 200K
      { left: 'volume',                   operation: 'greater', right: 200000 },
      // Listed exchanges only (no OTC)
      { left: 'exchange',                 operation: 'in_range', right: EXCHANGES },
    ],
    columns: [
      'name',                       // ticker
      'description',                // company name
      'exchange',
      'sector',
      'industry',
      'close',                      // last price
      'open',
      'high',
      'low',
      'volume',
      'relative_volume_10d_calc',   // relative volume vs 10-day avg
      'change',                     // % change today
      'gap',                        // gap % from prev close
      'market_cap_basic',
      'float_shares_outstanding',
      'short_ratio',                // short float %
      'average_volume_10d_calc',    // 10-day avg volume
      'High.52W',
      'Low.52W',
      // Catalysts
      'earnings_release_date',          // next earnings date
      'earnings_release_next_date',     // following earnings date
      'earnings_per_share_basic_ttm',   // EPS TTM
      'revenue_annual_yoy_growth_ttm',  // revenue growth
      'split_factor',                   // recent split factor (e.g. 0.5 = 2-for-1)
      'Type',                           // stock type (common, preferred, etc.)
    ],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    range: [0, 500],
  });

  const scannedAt = new Date().toISOString();

  return (result.data || []).map(row => {
    const [
      ticker, name, exchange, sector, industry,
      close, open, high, low, volume,
      rvol, change, gap, mcap, float_shares,
      short_ratio, avg_volume,
      high52w, low52w,
      earnings_date, earnings_next_date, eps_ttm, rev_growth, split_factor, stock_type,
    ] = row.d;

    // Detect catalyst flags
    const today = new Date().toISOString().slice(0, 10);
    const catalysts = [];
    if (earnings_date && earnings_date.slice(0,10) === today) catalysts.push('earnings');
    if (split_factor && split_factor !== 1) catalysts.push('split');

    // Build catalyst text for keyword matching
    const catalystText = [
      catalysts.join(' '),
      earnings_date ? 'earnings' : '',
      split_factor && split_factor !== 1
        ? (split_factor < 1 ? 'reverse split reverse stock split' : 'forward split stock split')
        : '',
    ].filter(Boolean).join(' ');

    return {
      ticker,
      name,
      exchange,
      sector,
      industry,
      stock_type:   stock_type   || null,
      price:        close,
      open,
      high,
      low,
      day_high:     high         || null,   // intraday high (key level for splits/catalysts)
      volume,
      avg_volume:   avg_volume   || null,
      rvol:         rvol         || null,
      change_pct:   change       || null,
      gap_pct:      gap          || null,
      mcap:         mcap         || null,
      float_shares: float_shares || null,
      short_ratio:  short_ratio  || null,
      high52w:      high52w      || null,
      low52w:       low52w       || null,
      pct_of_52w_high: (close && high52w) ? +((close / high52w) * 100).toFixed(1) : null,
      // Catalysts
      catalysts,
      earnings_date:      earnings_date      || null,
      earnings_next_date: earnings_next_date || null,
      eps_ttm:            eps_ttm            || null,
      rev_growth:         rev_growth         || null,
      split_factor:       split_factor       || null,
      // Keyword intelligence
      keyword_match: matchKeywords(catalystText),
      session,
      scanned_at: scannedAt,
    };
  });
}
