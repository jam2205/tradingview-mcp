import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/jetson.js';

export function registerJetsonTools(server) {
  server.tool('jetson_health_check', 'Check reachability of the Jetson pipeline builder (live FX data lake over the direct Ethernet link at 10.10.10.1:8769) and return its dataset catalog summary.', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'This desktop must hold 10.10.10.2/24 on the Ethernet NIC connected to the Jetson, with that NIC MAC-allowlisted on the Jetson bridge firewall.' }, true); }
  });

  server.tool('jetson_get_dataset_catalog', 'List the medallion-governed datasets available on the Jetson pipeline builder (candles, dealer levels, gamma/COT/vol regime features, ML-ready sets, etc.).', {
    verbose: z.coerce.boolean().optional().describe('Include full schema/params/url per dataset (default false — returns only name/governance/description/rows/age/status)'),
  }, async ({ verbose }) => {
    try { return jsonResult(await core.getDatasetCatalog({ verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_live_pairs', 'List the FX pairs and timeframes currently streaming on the Jetson live tick-bar ring, with per-pair file age in seconds.', {}, async () => {
    try { return jsonResult(await core.getLivePairs()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_live_bars', 'Get live OHLCV bars for one FX pair from the Jetson. Use summary=true for a compact regime/indicator readout instead of raw bars (saves context).', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
    tf: z.string().optional().describe('Timeframe: "1M", "5M", "15M", or "1H" (default "1M")'),
    limit: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return computed SMA/EMA/z-score/RSI/regime instead of raw bars — much smaller output'),
  }, async ({ pair, tf, limit, summary }) => {
    try { return jsonResult(await core.getLiveBars({ pair, tf, limit, summary })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_dataset', 'Fetch rows from any cataloged Jetson dataset by its URL (from jetson_get_dataset_catalog, e.g. "/v1/arrow/candles_1h").', {
    dataset_url: z.string().describe('Dataset URL from the catalog, e.g. "/v1/arrow/candles_1h"'),
    params: z.record(z.union([z.string(), z.number()])).optional().describe('Query params the dataset accepts (e.g. { pair: "EURUSD", limit: 200 })'),
  }, async ({ dataset_url, params }) => {
    try { return jsonResult(await core.getDataset({ dataset_url, params })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_synthesized_context', 'Zero-token-burn market context: pulls live bars for one or more FX pairs from the Jetson and returns pre-computed regime/SMA/EMA/z-score/RSI per pair (Jake VanClief Modular Standard distillation) instead of raw OHLCV — use this before reasoning about market state so you are not recomputing indicators from scratch.', {
    pairs: z.array(z.string()).optional().describe('FX pairs to analyze, e.g. ["EURUSD","GBPUSD"]. Omit for the top 5 live pairs.'),
    tf: z.string().optional().describe('Timeframe: "1M", "5M", "15M", or "1H" (default "15M")'),
    bars: z.coerce.number().optional().describe('Bars of lookback per pair for the computed stats (max 500, default 100)'),
  }, async ({ pairs, tf, bars }) => {
    try { return jsonResult(await core.getSynthesizedContext({ pairs, tf, bars })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_correlate_chart', 'Correlates the live TradingView chart with the Jetson FX data lake: reads the chart\'s current symbol/resolution (via chart_get_state), maps it to the matching Jetson pair/timeframe, and returns that pair\'s synthesized regime context. Use this instead of manually figuring out that the chart\'s "OANDA:EURUSD" is the Jetson\'s "EURUSD" — it reports explicitly when the symbol or resolution has no Jetson match rather than guessing.', {
    tf: z.string().optional().describe('Override the Jetson timeframe instead of deriving it from the chart resolution (e.g. "15M") — use when the chart is on a resolution Jetson doesn\'t cover (e.g. "D")'),
    bars: z.coerce.number().optional().describe('Bars of lookback for the computed stats (max 500, default 100)'),
  }, async ({ tf, bars }) => {
    try { return jsonResult(await core.correlateChart({ tf, bars })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
