#!/usr/bin/env node
import { evaluate, evaluateAsync, getChartApi, disconnect } from '../src/connection.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const legs = JSON.parse(process.argv[2] || '[]');
const requestedSymbol = process.argv[3] || '';
const tradeId = process.argv[4] || `plot-${Date.now()}`;
if (!legs.length) {
  console.error('No execution legs supplied');
  process.exit(1);
}

function toTimestamp(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const wallClockUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(wallClockUtc));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const displayedAsNewYork = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  const offset = displayedAsNewYork - wallClockUtc;
  return Math.floor((wallClockUtc - offset) / 1000);
}

const chartApi = await getChartApi();
const chartSymbolBefore = await evaluate(`${chartApi}.symbol()`);
if (requestedSymbol && chartSymbolBefore.toUpperCase() !== requestedSymbol.toUpperCase() && !chartSymbolBefore.toUpperCase().endsWith(`:${requestedSymbol.toUpperCase()}`)) {
  await evaluateAsync(`
    (function() {
      var api = ${chartApi};
      api.setSymbol(${JSON.stringify(requestedSymbol)}, {});
      return new Promise(function(resolve) { setTimeout(resolve, 1200); });
    })()
  `);
}
// Multiple partial fills routed to different venues for a single order
// typically land within a couple seconds of each other -- one arrow per
// fill there is just clutter. Cluster fills on the same side by actual time
// gap: fills no more than 5 seconds apart are the same order (one arrow, at
// their volume-weighted average price); a gap of more than 5 seconds starts
// a new order (a new arrow), even if it's still within the same clock hour.
const ORDER_GAP_SECONDS = 5;

function groupLegsForPlotting(rawLegs) {
  const bySide = {};
  for (const leg of rawLegs) {
    const ts = toTimestamp(leg.time);
    if (ts == null || !Number.isFinite(Number(leg.price))) continue;
    (bySide[leg.action] = bySide[leg.action] || []).push({ ...leg, ts });
  }

  const groups = [];
  for (const side of Object.keys(bySide)) {
    const sorted = bySide[side].slice().sort((a, b) => a.ts - b.ts);
    let current = null;
    let lastTs = null;
    for (const leg of sorted) {
      if (!current || lastTs == null || (leg.ts - lastTs) > ORDER_GAP_SECONDS) {
        current = { action: side, time: leg.time, ts: leg.ts, qty: 0, priceQtySum: 0, fills: 0 };
        groups.push(current);
      }
      const qty = Number(leg.qty) || 0;
      current.qty += qty;
      current.priceQtySum += Number(leg.price) * qty;
      current.fills += 1;
      lastTs = leg.ts;
    }
  }
  return groups.map(g => ({ action: g.action, time: g.time, qty: g.qty, price: g.qty ? g.priceQtySum / g.qty : 0, fills: g.fills }));
}

const chartSymbol = await evaluate(`${chartApi}.symbol()`);
const created = [];
const before = await evaluate(`${chartApi}.getAllShapes().map(function(s) { return s.id; })`);

for (const leg of groupLegsForPlotting(legs)) {
  const time = toTimestamp(leg.time);
  if (!time) continue;
  const isBuy = leg.action === 'BUY';
  const color = isBuy ? '#4af0a0' : '#f05060';
  const shape = isBuy ? 'arrow_up' : 'arrow_down';
  const fillsSuffix = leg.fills > 1 ? ` (${leg.fills} fills)` : '';
  const text = `[trade:${tradeId}] ${leg.action} ${leg.qty} @ ${leg.price.toFixed(2)}${fillsSuffix}`;
  const result = await evaluate(`
    (function() {
      var api = ${chartApi};
      return api.createShape(
        { time: ${time}, price: ${leg.price} },
        { shape: '${shape}', text: ${JSON.stringify(text)}, overrides: { color: '${color}', textColor: '${color}' } }
      );
    })()
  `);
  created.push({ action: leg.action, qty: leg.qty, price: leg.price, time, fills: leg.fills, entity_id: result || null });
}

const after = await evaluate(`${chartApi}.getAllShapes().map(function(s) { return s.id; })`);
const markerIds = (after || []).filter(id => !(before || []).includes(id));
const registryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'trade-markers.json');
mkdirSync(dirname(registryPath), { recursive: true });
const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
registry[tradeId] = { symbol: chartSymbol, ids: markerIds, updated_at: new Date().toISOString() };
writeFileSync(registryPath, JSON.stringify(registry, null, 2));
console.log(JSON.stringify({ chartSymbolBefore, chartSymbol, tradeId, plotted: created.length, marker_ids: markerIds, markers: created }));
await disconnect();
