/**
 * pivots.js
 * Calculates historical pivot levels for small cap stocks.
 *
 * A "pivot" is a price level that has repeatedly acted as support or resistance,
 * confirmed by high volume. The more times a level is touched with high RVol,
 * the stronger the pivot.
 *
 * Sources of pivot candidates (from our scan history):
 *   - day_high   → potential resistance
 *   - day_low    → potential support
 *   - open       → gap level (if different from prev close)
 *   - gap_pct    → significant gap levels
 *   - round numbers → psychological levels ($1,$2,$5,$10,$20,$50)
 *
 * Algorithm:
 *   1. Collect all price levels for a ticker across all scans
 *   2. Cluster levels within CLUSTER_PCT of each other
 *   3. Score each cluster: occurrences × avg_rvol × recency_weight
 *   4. Classify as Support (below current) or Resistance (above current)
 *   5. Return top N strongest levels
 */

import { getTickerHistory } from './db.js';

const CLUSTER_PCT   = 0.025;  // levels within 2.5% are the same zone
const RECENCY_DAYS  = 90;     // weight falls off over 90 days
const MAX_PIVOTS    = 10;     // max pivots to return per ticker

/**
 * Calculate pivot levels for a ticker from scan history.
 * @param {string} ticker
 * @param {number} currentPrice  - current price (to classify support/resistance)
 * @returns {{ pivots: array, ticker, current_price, calculated_at }}
 */
export function calculatePivots(ticker, currentPrice = null) {
  const history = getTickerHistory(ticker);
  if (!history.length) return { ticker, pivots: [], current_price: currentPrice, scans_used: 0, calculated_at: new Date().toISOString() };

  const now = Date.now();
  const candidates = [];

  for (const scan of history) {
    const scanDate  = new Date(scan.scanned_at).getTime();
    const ageDays   = (now - scanDate) / (1000 * 60 * 60 * 24);
    const recency   = Math.max(0.1, 1 - (ageDays / RECENCY_DAYS)); // 1.0 → 0.1 over 90 days
    const rvol      = scan.rvol || 1;
    const weight    = rvol * recency;

    // day_high → resistance candidate
    if (scan.high || scan.day_high) {
      candidates.push({
        price:   scan.high || scan.day_high,
        type:    'high',
        label:   'Day High',
        weight,
        rvol,
        date:    scan.scanned_at,
        session: scan.session,
        volume:  scan.volume,
        change:  scan.change_pct,
      });
    }

    // day_low → support candidate
    if (scan.low) {
      candidates.push({
        price:   scan.low,
        type:    'low',
        label:   'Day Low',
        weight,
        rvol,
        date:    scan.scanned_at,
        session: scan.session,
        volume:  scan.volume,
        change:  scan.change_pct,
      });
    }

    // open → gap level (only if there's a meaningful gap)
    if (scan.open && Math.abs(scan.gap_pct || 0) >= 3) {
      candidates.push({
        price:   scan.open,
        type:    'gap',
        label:   `Gap ${scan.gap_pct > 0 ? 'Up' : 'Down'} Open`,
        weight:  weight * 1.3, // gaps are more significant
        rvol,
        date:    scan.scanned_at,
        session: scan.session,
        volume:  scan.volume,
        change:  scan.change_pct,
      });
    }

    // price itself (close) — closing price is a key level
    if (scan.price) {
      candidates.push({
        price:   scan.price,
        type:    'close',
        label:   'Close',
        weight:  weight * 0.7, // closes are slightly less significant
        rvol,
        date:    scan.scanned_at,
        session: scan.session,
        volume:  scan.volume,
        change:  scan.change_pct,
      });
    }
  }

  // Add round number pivots if we have a price range
  const prices = candidates.map(c => c.price).filter(Boolean);
  if (prices.length) {
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const roundLevels = getRoundLevels(minP, maxP);
    for (const level of roundLevels) {
      candidates.push({
        price:   level,
        type:    'round',
        label:   `Round $${level}`,
        weight:  0.5,  // baseline psychological level
        rvol:    null,
        date:    null,
        session: null,
        volume:  null,
        change:  null,
      });
    }
  }

  // ── Cluster nearby levels ──────────────────────────────────────────────
  const clusters = clusterLevels(candidates);

  // ── Score and sort clusters ────────────────────────────────────────────
  const current = currentPrice || (history[history.length - 1]?.price) || null;

  const scored = clusters.map(cluster => {
    const avgPrice    = cluster.reduce((s,c) => s + c.price, 0) / cluster.length;
    const totalWeight = cluster.reduce((s,c) => s + c.weight, 0);
    const touches     = cluster.length;
    const avgRvol     = cluster.filter(c=>c.rvol).reduce((s,c)=>s+c.rvol,0) / (cluster.filter(c=>c.rvol).length || 1);
    const maxRvol     = Math.max(...cluster.map(c=>c.rvol||0));
    const types       = [...new Set(cluster.map(c=>c.type))];
    const labels      = [...new Set(cluster.map(c=>c.label))];
    const lastSeen    = cluster.filter(c=>c.date).sort((a,b)=>b.date.localeCompare(a.date))[0]?.date || null;
    const highVolTouches = cluster.filter(c => (c.rvol||0) >= 3).length;

    // Composite score
    const score = +(
      totalWeight *
      Math.log(touches + 1) *    // more touches = stronger
      (1 + highVolTouches * 0.5) // bonus for high-volume touches
    ).toFixed(2);

    // Classify
    let role = 'key_level';
    const highCount = cluster.filter(c=>c.type==='high').length;
    const lowCount  = cluster.filter(c=>c.type==='low').length;
    if (highCount > lowCount * 1.5)  role = 'resistance';
    else if (lowCount > highCount * 1.5) role = 'support';

    // Position relative to current price
    let position = null;
    if (current) {
      const pct = ((avgPrice - current) / current) * 100;
      position = { above: pct > 0, pct_away: +pct.toFixed(2) };
      // Override role based on position if unclear
      if (role === 'key_level') role = pct > 0 ? 'resistance' : 'support';
    }

    // Strength rating
    let strength = 'weak';
    if (score >= 20 || highVolTouches >= 3) strength = 'strong';
    else if (score >= 8 || touches >= 3)    strength = 'moderate';

    return {
      price:         +avgPrice.toFixed(4),
      score,
      strength,
      role,
      touches,
      high_vol_touches: highVolTouches,
      avg_rvol:      +avgRvol.toFixed(2),
      max_rvol:      +maxRvol.toFixed(2),
      types,
      labels,
      last_seen:     lastSeen,
      position,
    };
  });

  // Sort by score desc, take top N
  const pivots = scored
    .filter(p => p.touches >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PIVOTS)
    .sort((a, b) => b.price - a.price); // final sort by price (highest first)

  return {
    ticker,
    current_price:  current,
    scans_used:     history.length,
    calculated_at:  new Date().toISOString(),
    pivots,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clusterLevels(candidates) {
  // Sort by price
  const sorted = [...candidates].filter(c=>c.price>0).sort((a,b)=>a.price-b.price);
  const clusters = [];
  let current = [];

  for (const c of sorted) {
    if (!current.length) { current.push(c); continue; }
    const refPrice = current[0].price;
    if (Math.abs(c.price - refPrice) / refPrice <= CLUSTER_PCT) {
      current.push(c);
    } else {
      clusters.push(current);
      current = [c];
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

function getRoundLevels(minPrice, maxPrice) {
  const levels = [];
  // Determine step based on price range
  const steps = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const range = maxPrice - minPrice;
  const step  = steps.find(s => range / s <= 20) || 100;

  let l = Math.floor(minPrice / step) * step;
  while (l <= maxPrice * 1.1) {
    if (l >= minPrice * 0.9) levels.push(+l.toFixed(4));
    l = +(l + step).toFixed(4);
  }
  return levels;
}

/**
 * Build TradingView createShape() calls for CDP injection.
 * Returns JS code string to execute in TradingView via CDP.
 */
export function buildTVDrawCode(pivots, ticker) {
  const colorMap = {
    strong:   { support: '#3fb950', resistance: '#f85149', key_level: '#d29922' },
    moderate: { support: '#2ea043', resistance: '#da3633', key_level: '#bb8009' },
    weak:     { support: '#1a7f37', resistance: '#a40e26', key_level: '#735c0f' },
  };

  const lineWidth = { strong: 2, moderate: 1, weak: 1 };
  const lineStyle = { strong: 0, moderate: 0, weak: 2 }; // 0=solid, 2=dashed

  const lines = pivots.map(p => {
    const color = (colorMap[p.strength] || colorMap.weak)[p.role] || '#8b949e';
    const label = `${p.role.toUpperCase()[0]} ${p.strength.toUpperCase()[0]} $${p.price} (${p.touches}T RVol${p.avg_rvol}x)`;
    return `
  try {
    chart.createShape(
      { price: ${p.price} },
      {
        shape: 'horizontal_line',
        text: ${JSON.stringify(label)},
        lock: true,
        disableSelection: false,
        zOrder: 'top',
        overrides: {
          linecolor: '${color}',
          linewidth: ${lineWidth[p.strength] || 1},
          linestyle: ${lineStyle[p.strength] ?? 2},
          showLabel: true,
          textcolor: '${color}',
          fontsize: 11,
          bold: ${p.strength === 'strong'},
          transparency: 20,
        }
      }
    );
  } catch(e) {}`;
  }).join('\n');

  return `
(function() {
  try {
    var chart = window.tvWidget && window.tvWidget.activeChart
      ? window.tvWidget.activeChart()
      : null;
    if (!chart) return 'no_chart';

    // Remove old pivot lines first (lines with "S " or "R " or "K " in text)
    try {
      var shapes = chart.getAllShapes();
      shapes.forEach(function(s) {
        try {
          var props = chart.getShapeById(s.id);
          if (props && props.getProperties) {
            var p = props.getProperties();
            if (p.text && /^[SRK] /.test(p.text)) chart.removeEntity(s.id);
          }
        } catch(e) {}
      });
    } catch(e) {}

    ${lines}
    return 'ok:${pivots.length}';
  } catch(e) { return 'err:' + e.message; }
})()
`.trim();
}
