import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerJetsonTools } from './tools/jetson.js';

/**
 * Builds one fully-configured McpServer instance with every tool group
 * registered. Shared by both transports: src/server.js (stdio, one process
 * per Claude session) and src/server-http.js (Streamable HTTP, one
 * always-on process — see createServer() call sites for why each request
 * on the HTTP transport gets its own McpServer instance).
 */
export function createServer() {
  const server = new McpServer(
    {
      name: 'tradingview',
      version: '2.0.0',
      description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
    },
    {
      instructions: `TradingView MCP — 108 tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars
- data_find_swing_points → find exact swing high/low coordinates (bar time+price) so you don't have to scan raw bars yourself. To place your own narrated "popup" at a specific candle (e.g. "this was the session high before the reversal"): call this to get the coordinate, write the text yourself, then draw_shape (shape: "text", point: {time, price}) — the finder only locates WHERE, you supply WHAT it says

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

Jetson pipeline builder bridge (separate live FX data lake, direct Ethernet link, only reachable from this desktop):
- jetson_correlate_chart → the chart is on some symbol/resolution; the Jetson feed only knows plain FX pairs/timeframes. Use this FIRST when asked "what does the data say about what's on my chart" — it does the symbol/timeframe mapping for you and reports explicitly when there's no match, instead of you guessing that "OANDA:EURUSD" means Jetson's "EURUSD"
- jetson_health_check → verify the link and see the dataset catalog summary
- jetson_get_synthesized_context → ALWAYS prefer this over raw bars when reasoning about market regime for pairs you already know by name. Returns pre-computed SMA/EMA/z-score/RSI/regime per pair — do not recompute these yourself from raw OHLCV
- jetson_get_live_pairs / jetson_get_live_bars → raw live tick-bar access when you specifically need bars, not a summary (pass summary=true on jetson_get_live_bars for the same distilled readout, scoped to one pair)
- jetson_annotate_key_levels → gamma exposure walls/magnet + dealer prior day/week high-low + 20D dealer range, drawn straight onto the live chart as horizontal lines in ONE call (defaults to the chart's current symbol). Prefer this over separately fetching levels and calling draw_shape per level.
- jetson_get_gamma_levels / jetson_get_dealer_levels → the same level data without drawing, if you just need the numbers
- jetson_annotate_cot_sentiment → institutional COT positioning bias (LONG_BASE/SHORT_BASE/NEUTRAL) drawn as a text flag on the live chart in one call. jetson_get_cot_sentiment for the data alone. NEVER treat a missing/unavailable bias as neutral — it means a currency leg's report is stale (all 7 NZD pairs, permanently), not that positioning is balanced
- jetson_annotate_regime_shading → directional regime (BULL/BEAR/SIDEWAYS) shaded as a background rectangle + volatility phase (EXPANSION/COMPRESSION/EXHAUSTION) flagged as text, drawn separately since they are ORTHOGONAL classifiers — never combine into one label. EXPANSION is the ~92% base rate, not a signal; COMPRESSION/EXHAUSTION are the rare readings worth noting. jetson_get_directional_regime / jetson_get_volatility_regime for the data alone
- jetson_annotate_confluence_badge → the multi-layer confluence call (direction/strength/agreement) drawn as a text badge on the live chart in one call. jetson_get_confluence for the headline data alone, jetson_get_confluence_layers for WHY it's weak/strong (per-layer weight/staleness). NEVER present blend_weight as a probability — it's a fusion weighting. NEVER read agreement (e.g. "2/4") without n_layers_stale — the denominator moves
- jetson_get_currency_graph → the FX currency-node graph: one node per currency (COT positioning + calendar catalysts), one edge per pair (carry, COT bias, shared-risk coupling). Use this to reason about how currencies interlink, not just one pair alone. FX-only — no equities/index/metals nodes exist in this feed. jetson_get_currency_node / jetson_get_pair_edge for a single node/edge
- jetson_annotate_seasonality → real day-of-week/hour-of-day (UTC) seasonality drawn as a chart flag. NOT a native Jetson dataset — computed here from real candles_1h history, because the only seasonality-shaped columns on Jetson (day_of_week/hour_utc in enriched_signals) live in a dead, superseded table that must never be used as a live signal. Cross-references confluence's own weekly_profile layer (this-week bias, with its current trust weighting) alongside the historical average — AGREE/DIFFER flag, never blended into one number. jetson_get_seasonality for the data alone. Always weigh by sample size (n); Saturday/most-Sunday buckets are legitimately n:0
- jetson_get_dataset_catalog / jetson_get_dataset → the other medallion datasets (ML-ready sets, etc.)

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
    }
  );

  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerJetsonTools(server);

  return server;
}
