import CDP from 'chrome-remote-interface';

const symbol = process.argv[2] || 'NASDAQ:MSTR';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = targets.find(item => item.type === 'page' && /tradingview\.com\/chart/i.test(item.url));
if (!target) throw new Error('No TradingView chart target found');

const client = await CDP({ host: '127.0.0.1', port: 9222, target: target.id });
await client.Runtime.enable();
const result = await client.Runtime.evaluate({
  expression: `(function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var before = chart.symbol();
    chart.setSymbol(${JSON.stringify(symbol)}, {});
    return { before: before, symbol: chart.symbol(), resolution: chart.resolution(), title: document.title };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify({ target: target.title, ...(result.result?.value || {}) }));
await client.close();
