#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { evaluate, getChartApi, disconnect } from '../src/connection.js';

const tradeId = process.argv[2];
if (!tradeId) throw new Error('Trade ID required');
const registryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'trade-markers.json');
if (!existsSync(registryPath)) {
	console.log(JSON.stringify({ tradeId, removed: 0, message: 'No tracked markers for this trade' }));
	await disconnect();
	process.exit(0);
}
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const markerIds = registry[tradeId]?.ids || [];
const chartApi = await getChartApi();
let removed = 0;
for (const id of markerIds) {
	const result = await evaluate(`(function(){ var api=${chartApi}; var found=api.getAllShapes().some(function(s){return s.id===${JSON.stringify(id)}}); if(found) api.removeEntity(${JSON.stringify(id)}); return found; })()`);
	if (result) removed += 1;
}
delete registry[tradeId];
writeFileSync(registryPath, JSON.stringify(registry, null, 2));
console.log(JSON.stringify({ tradeId, removed, tracked: markerIds.length }));
await disconnect();
