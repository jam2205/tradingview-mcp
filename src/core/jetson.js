/**
 * Core logic for the Jetson pipeline builder bridge — a live FX data lake
 * reachable only over a direct Ethernet link (this desktop must hold
 * 10.10.10.2/24, MAC-allowlisted on the Jetson's bridge firewall). This is
 * independent of the CDP/chart connection in connection.js: it talks straight
 * to the Jetson's own FastAPI/Arrow service, not TradingView Desktop.
 *
 * Per the Jake VanClief Modular Standard already used for the Pine indicator
 * library: indicator math (SMA/EMA/stddev/RSI/z-score) is computed here,
 * server-side, so the agent receives a distilled numeric summary instead of
 * raw bar arrays it would otherwise have to reason over token-by-token.
 */
import { tableFromIPC } from 'apache-arrow';
import * as chart from './chart.js';

const JETSON_BASE_URL = process.env.JETSON_BASE_URL || 'http://10.10.10.1:8769';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_LIVE_BARS = 500;
const MAX_SYNTH_PAIRS = 10;

// TradingView symbols carry a broker/exchange prefix ("OANDA:EURUSD",
// "FX_IDC:EUR/USD", "BATS:AAPL") the Jetson feed knows nothing about — it
// only speaks plain 6-letter FX pairs ("EURUSD"). This strips the prefix and
// any separator, and returns null for anything that isn't shaped like an FX
// pair (equities, futures, crypto) rather than guessing.
const FX_PAIR_RE = /^[A-Z]{6}$/;
function extractFxPair(symbol) {
  if (!symbol) return null;
  const afterColon = symbol.includes(':') ? symbol.split(':').pop() : symbol;
  const cleaned = afterColon.replace(/[^A-Za-z]/g, '').toUpperCase();
  return FX_PAIR_RE.test(cleaned) ? cleaned : null;
}

// TradingView chart resolutions ("1", "5", "15", "60", "D", ...) vs. the
// Jetson's own timeframe strings ("1M", "5M", "15M", "1H"). Only exact
// matches are mapped — a chart on "D" or "240" has no Jetson equivalent, and
// guessing the nearest one would silently correlate the wrong data.
const RESOLUTION_TO_JETSON_TF = { 1: '1M', 5: '5M', 15: '15M', 60: '1H' };
function mapResolutionToJetsonTf(resolution) {
  return RESOLUTION_TO_JETSON_TF[resolution] ?? null;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

// Runs one Jetson request under a single abort timeout that stays armed
// through `consume(res)` (not just until headers arrive) — a stalled Arrow/
// JSON body on an otherwise-responsive connection would otherwise hang past
// the advertised timeout, since fetch() itself resolves as soon as headers
// are in.
async function jetsonRequest(pathAndQuery, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${JETSON_BASE_URL}${pathAndQuery}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Jetson HTTP ${res.status} on ${pathAndQuery}`);
    return await consume(res);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Jetson request timed out after ${REQUEST_TIMEOUT_MS}ms — check the direct Ethernet link (this desktop needs 10.10.10.2/24 on its NIC, MAC-allowlisted on the Jetson's bridge firewall)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const jetsonFetchJson = (pathAndQuery) => jetsonRequest(pathAndQuery, (res) => res.json());

const jetsonFetchArrowRows = (pathAndQuery) => jetsonRequest(pathAndQuery, async (res) => {
  const buf = new Uint8Array(await res.arrayBuffer());
  const table = tableFromIPC(buf);
  const fieldNames = table.schema.fields.map((f) => f.name);
  return table.toArray().map((row) => {
    const plain = {};
    for (const key of fieldNames) {
      let value = row[key];
      if (typeof value === 'bigint') {
        // Nanosecond timestamps / 64-bit IDs can exceed Number.MAX_SAFE_INTEGER —
        // casting those to Number silently corrupts them, so keep out-of-range
        // values as exact decimal strings instead.
        value = (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) ? Number(value) : value.toString();
      } else if (value instanceof Date) {
        value = value.toISOString();
      }
      plain[key] = value;
    }
    return plain;
  });
});

const round = (v, dp = 5) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function stddev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Distills a raw bar array into the compact regime/indicator summary the agent actually needs. */
function summarizeBars(rows) {
  const closes = rows.map((r) => r.close).filter((v) => typeof v === 'number');
  if (closes.length < 2) throw new Error('Not enough closed bars to summarize');
  const first = rows[0];
  const last = rows[rows.length - 1];
  const lastClose = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const std20 = stddev(closes, 20);
  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const zscore20 = std20 ? (lastClose - sma20) / std20 : null;

  let regime = 'unknown';
  if (zscore20 != null) {
    if (zscore20 > 0.5) regime = 'bullish_expansion';
    else if (zscore20 < -0.5) regime = 'bearish_contraction';
    else regime = 'range_bound';
  }

  return {
    bar_count: rows.length,
    period: { from: first.time, to: last.time },
    last_close: round(lastClose),
    change_pct: first.close ? round(((last.close - first.close) / first.close) * 100, 3) : null,
    sma20: round(sma20),
    ema20: round(ema20),
    zscore20: round(zscore20, 3),
    rsi14: round(rsi14, 2),
    regime,
  };
}

export async function healthCheck() {
  const started = Date.now();
  const body = await jetsonFetchJson('/health');
  return { success: true, reachable: true, latency_ms: Date.now() - started, ...body };
}

export async function getDatasetCatalog({ verbose } = {}) {
  const body = await jetsonFetchJson('/v1/arrow/datasets');
  const datasets = body.datasets || [];
  if (verbose) return { success: true, count: datasets.length, datasets };
  return {
    success: true,
    count: datasets.length,
    datasets: datasets.map((d) => ({
      name: d.name,
      governance: d.governance,
      description: d.description,
      rows: d.rows,
      age_h: d.age_h,
      status: d.status,
    })),
  };
}

export async function getLivePairs() {
  const body = await jetsonFetchJson('/v1/arrow/live_bars/pairs');
  return { success: true, ...body };
}

export async function getLiveBars({ pair, tf, limit, summary } = {}) {
  if (!pair) throw new Error('pair is required (e.g. "EURUSD")');
  const timeframe = tf || '1M';
  const n = Math.min(limit || 100, MAX_LIVE_BARS);
  const rows = await jetsonFetchArrowRows(`/v1/arrow/live_bars?pair=${encodeURIComponent(pair)}&tf=${encodeURIComponent(timeframe)}&limit=${n}`);
  if (!rows.length) throw new Error(`No live bars returned for ${pair} ${timeframe}`);

  if (summary) return { success: true, pair, tf: timeframe, ...summarizeBars(rows) };
  return { success: true, pair, tf: timeframe, bar_count: rows.length, bars: rows };
}

export async function getDataset({ dataset_url, params } = {}) {
  if (!dataset_url) throw new Error('dataset_url is required (from jetson_get_dataset_catalog, e.g. "/v1/arrow/candles_1h")');
  const query = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const rows = await jetsonFetchArrowRows(`${dataset_url}${query ? `?${query}` : ''}`);
  return { success: true, dataset_url, row_count: rows.length, rows };
}

/**
 * The zero-token-burn tool: pulls live bars for one or more pairs and returns
 * pre-computed regime/indicator readings per pair instead of raw OHLCV — the
 * agent gets the answer, not the homework.
 */
export async function getSynthesizedContext({ pairs, tf, bars } = {}) {
  const timeframe = tf || '15M';
  const lookback = Math.min(bars || 100, MAX_LIVE_BARS);

  let targets = pairs;
  if (!targets || !targets.length) {
    const live = await getLivePairs();
    targets = (live.pairs || []).slice(0, 5);
  }
  targets = targets.slice(0, MAX_SYNTH_PAIRS);

  const results = [];
  for (const pair of targets) {
    try {
      const rows = await jetsonFetchArrowRows(`/v1/arrow/live_bars?pair=${encodeURIComponent(pair)}&tf=${encodeURIComponent(timeframe)}&limit=${lookback}`);
      results.push({ pair, ...summarizeBars(rows) });
    } catch (err) {
      results.push({ pair, error: err.message });
    }
  }

  const distilled = { pairs: results, tf: timeframe, bars_analyzed_per_pair: lookback };
  const distilledTokenEstimate = Math.ceil(JSON.stringify(distilled).length / 3.8);
  const rawTokenEstimate = Math.ceil((targets.length * lookback * 55) / 3.8);

  return {
    success: true,
    ...distilled,
    token_footprint: {
      raw_estimate: rawTokenEstimate,
      distilled_estimate: distilledTokenEstimate,
      savings_pct: rawTokenEstimate ? Math.round((1 - distilledTokenEstimate / rawTokenEstimate) * 100) : null,
    },
    note: 'Regime/SMA/EMA/z-score/RSI computed server-side (Jake VanClief Modular Standard) — no need to recompute these from raw bars.',
  };
}

/**
 * The connective tissue between the two data sources: reads whatever symbol
 * and timeframe is actually on the live TradingView chart (via CDP) and maps
 * it to the matching Jetson FX pair/timeframe, then returns that pair's
 * synthesized regime context — so "what does the alt-data feed say about
 * what I'm looking at right now" doesn't require the agent (or a human) to
 * manually work out that the chart's "OANDA:EURUSD" is the Jetson's
 * "EURUSD". Every failure mode (unmapped symbol, unmapped resolution, pair
 * not currently live) is reported explicitly rather than silently guessing.
 */
export async function correlateChart({ tf: tfOverride, bars, _deps } = {}) {
  const state = await chart.getState({ _deps });
  const pair = extractFxPair(state.symbol);
  const tf = tfOverride || mapResolutionToJetsonTf(state.resolution);

  const base = {
    success: true,
    chart_symbol: state.symbol,
    chart_resolution: state.resolution,
    mapped_pair: pair,
    mapped_tf: tf,
  };

  if (!pair) {
    return {
      ...base,
      correlated: false,
      reason: `Chart symbol "${state.symbol}" doesn't look like an FX pair the Jetson feed covers (expected a 6-letter pair like EURUSD, with or without a broker prefix before ":").`,
    };
  }
  if (!tf) {
    return {
      ...base,
      correlated: false,
      reason: `TradingView resolution "${state.resolution}" has no direct Jetson timeframe match. Jetson covers 1-minute/5-minute/15-minute/1-hour bars — pass tf explicitly (e.g. tf: "15M") to correlate anyway.`,
      available_jetson_timeframes: ['1M', '5M', '15M', '1H'],
    };
  }

  const live = await getLivePairs();
  if (!(live.pairs || []).includes(pair)) {
    return {
      ...base,
      correlated: false,
      reason: `Jetson isn't currently streaming "${pair}".`,
      jetson_live_pairs: live.pairs,
    };
  }

  const context = await getSynthesizedContext({ pairs: [pair], tf, bars });
  return { ...base, correlated: true, jetson: context.pairs[0], token_footprint: context.token_footprint };
}
