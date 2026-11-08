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
// symbolExt() is null when the chart's symbol never resolved (e.g. "NASDAQ:BE" for an
// NYSE stock) -- that chart has no bars and rejects every createShape, so reload it.
const chartResolved = await evaluate(`!!${chartApi}.symbolExt()`);
const sameTicker = chartSymbolBefore.toUpperCase() === requestedSymbol.toUpperCase() || chartSymbolBefore.toUpperCase().endsWith(`:${requestedSymbol.toUpperCase()}`);
if (requestedSymbol && (!sameTicker || !chartResolved)) {
  await evaluateAsync(`
    (function() {
      var api = ${chartApi};
      api.setSymbol(${JSON.stringify(requestedSymbol)}, {});
      return new Promise(function(resolve) { setTimeout(resolve, 2500); });
    })()
  `);
}
// Journal times are New York wall-clock. A chart left on another display timezone
// (it was Europe/Athens, UTC+3) shows a 10:08 fill at 17:08 and an after-hours fill on
// the next day -- so put the chart on New York time before drawing.
const chartTimezoneBefore = await evaluate(`(function() { try { return ${chartApi}.getTimezoneApi().getTimezone().id; } catch (e) { return null; } })()`);
if (chartTimezoneBefore && chartTimezoneBefore !== 'America/New_York') {
  await evaluate(`(function() { try { ${chartApi}.getTimezoneApi().setTimezone('America/New_York'); } catch (e) {} })()`);
}
const chartTimezone = await evaluate(`(function() { try { return ${chartApi}.getTimezoneApi().getTimezone().id; } catch (e) { return null; } })()`);

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

// TradingView only keeps ~1 month of intraday bars loaded, and createShape snaps a
// point older than the first loaded bar onto that bar -- so a July trade was drawn on
// early September. Page history in (as scrolling left does) until it covers the trade.
const legTimes = legs.map(leg => toTimestamp(leg.time)).filter(ts => ts != null);
const tradeFrom = Math.min(...legTimes);
const tradeTo = Math.max(...legTimes);
const history = await evaluateAsync(`
  (async function() {
    var api = ${chartApi};
    var model = api._chartWidget.model();
    var series = model.mainSeries();
    function firstBar() { var b = series.bars(); return b.size() ? b.valueAt(b.firstIndex())[0] : null; }
    var started = Date.now();
    while (!(firstBar() <= ${tradeFrom}) && Date.now() - started < 20000) {
      var size = series.bars().size();
      model.timeScale().scrollToFirstBar();
      await new Promise(function(r) { setTimeout(r, 300); });
      series.requestMoreData(2000);
      var waited = Date.now();
      while (series.bars().size() === size && Date.now() - waited < 5000) await new Promise(function(r) { setTimeout(r, 200); });
      if (series.bars().size() === size) break;
    }
    var disconnected = Array.from(document.querySelectorAll('button')).some(function(b) { return b.textContent.trim() === 'Reconnect'; });
    return { firstBar: firstBar(), covered: firstBar() !== null && firstBar() <= ${tradeFrom}, disconnected: disconnected };
  })()
`);
if (!history.covered) {
  const why = history.disconnected
    ? 'TradingView lost its data connection -- click Reconnect in the TradingView tab and plot again'
    : `chart history only goes back to ${new Date((history.firstBar || 0) * 1000).toISOString().slice(0, 10)}`;
  console.error(`Cannot plot on the trade's dates: ${why}`);
  await disconnect();
  process.exit(1);
}

const resolution = String(await evaluate(`${chartApi}.resolution()`));
// Bar length in seconds: "60" = 60 minutes, "30S" = 30 seconds, D/W/M = daily and up.
const barSeconds = /S$/.test(resolution) ? Number(resolution.slice(0, -1)) || 1
  : /^\d+$/.test(resolution) ? Number(resolution) * 60 : null;
const intraday = barSeconds != null;
const nyDate = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Show the trade: centre the chart on it with some context either side. Intraday: 15 bars
// of padding (at least 10 minutes); daily and up: a day either side. The old zoomToBarsRange
// call used bar indexes captured before the paged-in history settled, so on 1m/5m charts
// the view was left at the very first loaded bar (04:00 of the first day) instead of the
// trade. Time-based setVisibleRange + a read-back check fixes that.
const zoomPad = intraday ? 0 : 86400;
const padBars = intraday ? 15 : 10;
async function zoomToTrade() {
  for (let attempt = 0; attempt < 6; attempt++) {
    // Bar indexes are re-read on every attempt (late-loading history renumbers them) and the
    // resulting view is read back; setVisibleRange is "Not implemented" in this build.
    const ok = await evaluateAsync(`
      (function() {
        var model = ${chartApi}._chartWidget.model();
        var ts = model.timeScale();
        var bars = model.mainSeries().bars();
        var fromIdx = null, toIdx = null;
        for (var i = bars.firstIndex(); i <= bars.lastIndex(); i++) {
          var v = bars.valueAt(i);
          if (!v) continue;
          if (fromIdx === null && v[0] >= ${tradeFrom} - ${zoomPad}) fromIdx = i;
          if (v[0] <= ${tradeTo} + ${zoomPad}) toIdx = i;
        }
        if (fromIdx === null || toIdx === null) return Promise.resolve(false);
        var lo = Math.max(bars.firstIndex(), fromIdx - ${padBars}), hi = Math.min(bars.lastIndex(), toIdx + ${padBars});
        ts.zoomToBarsRange(lo, hi);
        // A pane left with auto-scale off (manual price drag) keeps the old price window, so the
        // candles sit off-screen at the new time -- turn auto-scale back on.
        try { var ps = model.mainSeries().priceScale(); if (!ps.isAutoScale()) ps.resetScale(); } catch (e) {}
        return new Promise(function(resolve) {
          setTimeout(function() {
            var r = ts.visibleBarsStrictRange();
            resolve(!!r && r.firstBar() <= fromIdx && r.lastBar() >= toIdx);
          }, 700);
        });
      })()
    `);
    if (ok) return true;
  }
  return false;
}
const zoomed = await zoomToTrade();

const chartSymbol = await evaluate(`${chartApi}.symbol()`);
// Intraday: the arrow must sit on the bar that contains the fill (bar open <= fill time
// < bar close). The old one-day tolerance let a pre-market fill on a regular-hours chart
// snap onto the previous day's last bar and still count as plotted.
const maxSnapSeconds = intraday ? barSeconds : /W$/.test(resolution) ? 8 * 86400 : /M$/.test(resolution) ? 32 * 86400 : 86400;
const created = [];
const failed = [];
const before = await evaluate(`${chartApi}.getAllShapes().map(function(s) { return s.id; })`);

for (const leg of groupLegsForPlotting(legs)) {
  const time = toTimestamp(leg.time);
  if (!time) continue;
  const isBuy = leg.action === 'BUY';
  const color = isBuy ? '#4af0a0' : '#f05060';
  const shape = isBuy ? 'arrow_up' : 'arrow_down';
  const fillsSuffix = leg.fills > 1 ? ` (${leg.fills} fills)` : '';
  const text = `[trade:${tradeId}] ${leg.action} ${leg.qty} @ ${leg.price.toFixed(2)}${fillsSuffix}`;
  // createShape returns a Promise in current TradingView builds; it must be awaited, or a
  // rejection ("Cannot create shape") is silently reported as a successful plot.
  const result = await evaluateAsync(`
    (function() {
      var api = ${chartApi};
      return Promise.resolve(api.createShape(
        { time: ${time}, price: ${leg.price} },
        { shape: '${shape}', text: ${JSON.stringify(text)}, overrides: { color: '${color}', textColor: '${color}' } }
      )).then(function(id) { return { id: id }; }, function(err) { return { error: String((err && err.message) || err) }; });
    })()
  `);
  if (result && result.error) {
    failed.push({ action: leg.action, price: leg.price, time, error: result.error });
    continue;
  }
  // Check where the arrow actually landed: snapping to its own bar (within a day, or one
  // bar on weekly/monthly charts) is normal; anything further was moved off the trade's date.
  const placed = await evaluate(`(function() { try { return ${chartApi}.getShapeById(${JSON.stringify(result.id)}).getPoints()[0].time; } catch (e) { return null; } })()`);
  const wrongBar = placed == null || Math.abs(time - placed) >= maxSnapSeconds || (intraday && placed > time);
  // Daily bars are stamped 00:00 UTC of their session date, so read that date in UTC.
  const placedDay = placed == null ? null : intraday ? nyDate(placed) : new Date(placed * 1000).toISOString().slice(0, 10);
  const wrongDay = placed != null && !/[WM]$/.test(resolution) && placedDay !== nyDate(time);
  if (wrongBar || wrongDay) {
    await evaluate(`(function() { try { ${chartApi}.removeEntity(${JSON.stringify(result.id)}); } catch (e) {} })()`);
    const at = placed == null ? 'nowhere' : intraday ? `${placedDay} ${new Date(placed * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York' })} ET` : `the ${placedDay} bar`;
    const hint = intraday ? ' -- is the fill outside the chart session? turn on extended hours' : '';
    failed.push({ action: leg.action, price: leg.price, time, trade_time: `${leg.time} ET`, error: `fill at ${leg.time} ET landed at ${at}${hint}` });
    continue;
  }
  created.push({ action: leg.action, qty: leg.qty, price: leg.price, time, trade_time: `${leg.time} ET`, placed, fills: leg.fills, entity_id: result.id });
}

await zoomToTrade();   // late-loading history can shift the view again; re-assert it
const after = await evaluate(`${chartApi}.getAllShapes().map(function(s) { return s.id; })`);
const markerIds = (after || []).filter(id => !(before || []).includes(id));
const registryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'trade-markers.json');
mkdirSync(dirname(registryPath), { recursive: true });
const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
registry[tradeId] = { symbol: chartSymbol, ids: markerIds, updated_at: new Date().toISOString() };
writeFileSync(registryPath, JSON.stringify(registry, null, 2));
console.log(JSON.stringify({ chartSymbolBefore, chartSymbol, chartTimezoneBefore, chartTimezone, resolution, tradeId, plotted: created.length, zoomed, marker_ids: markerIds, markers: created, failed }));
await disconnect();
if (failed.length) {
  console.error(`${failed.length} of ${failed.length + created.length} markers could not be drawn on ${chartSymbol}: ${failed[0].error}`);
  process.exit(1);
}
