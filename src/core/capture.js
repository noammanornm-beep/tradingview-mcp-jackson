/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function captureScreenshot({ region, filename, method } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = filename || `tv_${region}_${ts}`;
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  // Get viewport size to compute scale — keeps screenshots under Anthropic's 2000px limit
  const MAX_DIM = 1900;
  const layout = await client.Page.getLayoutMetrics().catch(() => null);
  const vpW = layout?.cssLayoutViewport?.clientWidth || layout?.layoutViewport?.clientWidth || 1920;
  const vpH = layout?.cssLayoutViewport?.clientHeight || layout?.layoutViewport?.clientHeight || 1080;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) {
      const scale = Math.min(1, MAX_DIM / Math.max(bounds.width, bounds.height));
      clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale };
    }
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) {
      const scale = Math.min(1, MAX_DIM / Math.max(bounds.width, bounds.height));
      clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale };
    }
  } else {
    // Full screenshot — scale down if viewport exceeds limit
    const scale = Math.min(1, MAX_DIM / Math.max(vpW, vpH));
    if (scale < 1) clip = { x: 0, y: 0, width: vpW, height: vpH, scale };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
