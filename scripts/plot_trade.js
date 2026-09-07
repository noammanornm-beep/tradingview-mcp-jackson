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
const chartSymbol = await evaluate(`${chartApi}.symbol()`);
const created = [];
const before = await evaluate(`${chartApi}.getAllShapes().map(function(s) { return s.id; })`);

for (const leg of legs) {
  const time = toTimestamp(leg.time);
  if (!time || !Number.isFinite(Number(leg.price))) continue;
  const isBuy = leg.action === 'BUY';
  const color = isBuy ? '#4af0a0' : '#f05060';
  const shape = isBuy ? 'arrow_up' : 'arrow_down';
  const text = `[trade:${tradeId}] ${leg.action} ${leg.qty} @ ${Number(leg.price).toFixed(2)}`;
  const result = await evaluate(`
    (function() {
      var api = ${chartApi};
      return api.createShape(
        { time: ${time}, price: ${Number(leg.price)} },
        { shape: '${shape}', text: ${JSON.stringify(text)}, overrides: { color: '${color}', textColor: '${color}' } }
      );
    })()
  `);
  created.push({ action: leg.action, qty: leg.qty, price: leg.price, time, entity_id: result || null });
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
