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

  server.tool('jetson_get_gamma_levels', 'Get dealer gamma exposure levels for an FX pair from Saxo options data (the gamma "walls" and the gamma-weighted magnet strike). FX majors only — the 20 minor crosses have no listed vanilla options, so "available: false" for those is expected, not an error.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getGammaLevels({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_dealer_levels', 'Get dealer reference levels for an FX pair: prior day/week high-low and the 20-day dealer range extremes.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getDealerLevels({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_annotate_key_levels', 'Fetches gamma exposure levels + dealer reference levels for an FX pair (defaulting to whatever symbol is on the live chart) and draws them as horizontal lines directly on the chart in one call — gamma walls/magnet, prior day/week high-low, 20-day dealer range. Pass draw=false to just fetch the levels without drawing anything.', {
    pair: z.string().optional().describe('FX pair, e.g. "EURUSD". Omit to use the symbol currently on the live chart.'),
    draw: z.coerce.boolean().optional().describe('Draw the levels on the chart (default true). Set false to only fetch the data.'),
  }, async ({ pair, draw }) => {
    try { return jsonResult(await core.annotateKeyLevels({ pair, draw })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_cot_sentiment', 'Get institutional COT (Commitment of Traders) positioning bias for an FX pair — base currency index minus quote currency index, with a LONG_BASE/SHORT_BASE/NEUTRAL direction. Reports available:false (never a fake neutral) when a currency leg\'s weekly report is stale — this is expected for all 7 NZD pairs, which are permanently stale since 2022.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getCotSentiment({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_annotate_cot_sentiment', 'Draws the current COT institutional bias as a text flag on the live chart (defaulting to whatever symbol is on the chart), anchored near the current price. Pass draw=false to just fetch the sentiment without drawing. Draws nothing (drawn:false) when the sentiment is unavailable/stale rather than drawing a misleading neutral flag.', {
    pair: z.string().optional().describe('FX pair, e.g. "EURUSD". Omit to use the symbol currently on the live chart.'),
    draw: z.coerce.boolean().optional().describe('Draw the flag on the chart (default true). Set false to only fetch the data.'),
  }, async ({ pair, draw }) => {
    try { return jsonResult(await core.annotateCotSentiment({ pair, draw })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_directional_regime', 'Get the current directional market regime (BULL/BEAR/SIDEWAYS) for an FX pair from the HMM classifier. This is an independent axis from volatility phase — never combine the two into one label.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getDirectionalRegime({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_volatility_regime', 'Get the current volatility-phase regime (EXPANSION/COMPRESSION/EXHAUSTION) for an FX pair from the HMM classifier. EXPANSION is the base rate (~92% of readings) and is not itself a signal; COMPRESSION/EXHAUSTION are the rare, meaningful readings. Independent axis from directional regime — never combine the two.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getVolatilityRegime({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_annotate_regime_shading', 'Shades recent price action on the live chart with the directional regime (translucent background rectangle: green=BULL, red=BEAR, gray=SIDEWAYS) and flags the volatility phase separately (text label) — defaulting to whatever symbol is on the chart. These are drawn as two distinct objects because they are orthogonal classifiers, never a combined state. Pass draw=false to just fetch both regimes without drawing.', {
    pair: z.string().optional().describe('FX pair, e.g. "EURUSD". Omit to use the symbol currently on the live chart.'),
    draw: z.coerce.boolean().optional().describe('Draw the shading/flag on the chart (default true). Set false to only fetch the data.'),
    lookbackBars: z.coerce.number().optional().describe('Bars of recent price action to size the shading rectangle against (default 50)'),
    tf: z.string().optional().describe('Jetson timeframe for sizing the shading band: "1M", "5M", "15M", or "1H" (default "15M")'),
  }, async ({ pair, draw, lookbackBars, tf }) => {
    try { return jsonResult(await core.annotateRegimeShading({ pair, draw, lookbackBars, tf })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_confluence', 'Get the multi-layer confluence call for an FX pair: direction, strength, agreement, and staleness. blend_weight is a fusion weighting, NOT a probability of the call being correct — never present it as one. agreement\'s denominator moves with n_layers_stale, so always read it alongside n_layers/n_layers_stale, not as a fixed scale.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getConfluence({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_get_confluence_layers', 'Get the per-layer breakdown behind an FX pair\'s confluence call (which contributing models/layers agree, their weight, damped_weight, age, and staleness). This explains WHY a call is weak or strong, not just its headline number — a damped_weight of 0 is expected freshness damping, not missing data.', {
    pair: z.string().describe('FX pair, e.g. "EURUSD"'),
  }, async ({ pair }) => {
    try { return jsonResult(await core.getConfluenceLayers({ pair })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jetson_annotate_confluence_badge', 'Draws the multi-layer confluence call as a text badge on the live chart (defaulting to whatever symbol is on the chart), anchored near current price, with layer staleness surfaced directly in the badge text. Pass draw=false to just fetch the confluence without drawing.', {
    pair: z.string().optional().describe('FX pair, e.g. "EURUSD". Omit to use the symbol currently on the live chart.'),
    draw: z.coerce.boolean().optional().describe('Draw the badge on the chart (default true). Set false to only fetch the data.'),
  }, async ({ pair, draw }) => {
    try { return jsonResult(await core.annotateConfluenceBadge({ pair, draw })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
