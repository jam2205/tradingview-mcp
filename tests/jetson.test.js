/**
 * Tests for the Jetson pipeline builder bridge (src/core/jetson.js) — the
 * live FX data lake reached over a direct Ethernet link, independent of the
 * CDP/chart connection. Mocks global.fetch so these run without a real Jetson.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import * as jetson from '../src/core/jetson.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function arrowResponse(table, ok = true) {
  const bytes = tableToIPC(table, 'stream');
  return { ok, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function makeBarsTable({ count = 30, start = 1.1, drift = 0.001, trendUp = true } = {}) {
  const time = [], open = [], high = [], low = [], close = [], volume = [];
  let px = start;
  for (let i = 0; i < count; i++) {
    const o = px;
    const step = (trendUp ? 1 : -1) * drift;
    const c = o + step;
    time.push(BigInt(1000 * i));
    open.push(o); close.push(c);
    high.push(Math.max(o, c) + 0.0001);
    low.push(Math.min(o, c) - 0.0001);
    volume.push(10);
    px = c;
  }
  return tableFromArrays({ time, open, high, low, close, volume });
}

describe('jetson core — health/catalog/pairs', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('healthCheck() reports reachable and passes through the Jetson body', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true, datasets: ['a', 'b'], port: 8769 });
    const result = await jetson.healthCheck();
    assert.equal(result.success, true);
    assert.equal(result.reachable, true);
    assert.deepEqual(result.datasets, ['a', 'b']);
    assert.equal(typeof result.latency_ms, 'number');
  });

  it('healthCheck() surfaces a clear error when the Jetson is unreachable', async () => {
    globalThis.fetch = async () => { const e = new Error('fetch failed'); throw e; };
    await assert.rejects(() => jetson.healthCheck(), /fetch failed/);
  });

  it('getDatasetCatalog() strips schema/url/params by default, keeps them when verbose', async () => {
    const full = { name: 'candles_1h', governance: 'gold', description: 'x', rows: 10, age_h: 0.1, status: 'ok', schema: [{ name: 'close', type: 'float64' }], url: '/v1/arrow/candles_1h', params: ['pair'] };
    globalThis.fetch = async () => jsonResponse({ datasets: [full] });

    const compact = await jetson.getDatasetCatalog({});
    assert.equal(compact.datasets[0].schema, undefined);

    const verbose = await jetson.getDatasetCatalog({ verbose: true });
    assert.deepEqual(verbose.datasets[0].schema, full.schema);
  });

  it('getLivePairs() passes through pairs/timeframes', async () => {
    globalThis.fetch = async () => jsonResponse({ timeframes: ['1M'], pairs: ['EURUSD'], file_age_seconds: {} });
    const result = await jetson.getLivePairs();
    assert.deepEqual(result.pairs, ['EURUSD']);
  });
});

describe('jetson core — getLiveBars()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('requires a pair', async () => {
    await assert.rejects(() => jetson.getLiveBars({}), /pair is required/);
  });

  it('returns raw bars by default', async () => {
    globalThis.fetch = async () => arrowResponse(makeBarsTable({ count: 5 }));
    const result = await jetson.getLiveBars({ pair: 'EURUSD' });
    assert.equal(result.bar_count, 5);
    assert.equal(result.bars.length, 5);
    assert.equal(typeof result.bars[0].close, 'number');
  });

  // Reproduces a real, verified quirk of the Jetson live_bars API: when a
  // request exceeds how many bars fit in that timeframe's ring-buffer
  // window, the API prepends a duplicate of the current in-progress bar and
  // returns the rest out of chronological order (confirmed live, repeatedly
  // reproducible for 1H/15M/5M once the limit exceeds ~10/~33/~94 bars
  // respectively). getLiveBars must sort+dedupe rather than trust order.
  it('sorts and de-duplicates a corrupted (duplicate-prepended, out-of-order) API response', async () => {
    const clean = makeBarsTable({ count: 5 }).toArray();
    const corrupted = [clean[clean.length - 1], ...clean]; // exact shape observed live
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const cols = {};
    for (const k of Object.keys(corrupted[0])) cols[k] = corrupted.map((r) => r[k]);
    globalThis.fetch = async () => arrowResponse(tfa(cols));

    const result = await jetson.getLiveBars({ pair: 'EURUSD' });
    assert.equal(result.bar_count, 5); // de-duplicated back to the true 5 bars
    const times = result.bars.map((b) => Number(b.time));
    const sorted = [...times].sort((a, b) => a - b);
    assert.deepEqual(times, sorted); // ascending, not the corrupted API order
    assert.equal(new Set(times).size, 5); // no duplicate timestamp survives
  });

  it('summary mode computes period/change_pct from the TRUE oldest/newest bar, not array position, given a corrupted response', async () => {
    const clean = makeBarsTable({ count: 40, trendUp: true, drift: 0.002 }).toArray();
    const corrupted = [clean[clean.length - 1], ...clean];
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const cols = {};
    for (const k of Object.keys(corrupted[0])) cols[k] = corrupted.map((r) => r[k]);
    globalThis.fetch = async () => arrowResponse(tfa(cols));

    const result = await jetson.getLiveBars({ pair: 'EURUSD', summary: true });
    // With the bug, "first" would be the duplicated current bar, collapsing
    // change_pct to ~0% and period.from===period.to. Fixed, it must reflect
    // the real 40-bar uptrend.
    assert.equal(result.period.from, Number(clean[0].time));
    assert.equal(result.period.to, Number(clean[clean.length - 1].time));
    assert.ok(result.change_pct > 0, `expected a positive change_pct for a steady uptrend, got ${result.change_pct}`);
    assert.equal(result.regime, 'bullish_expansion');
  });

  it('preserves in-range bigints as numbers but keeps out-of-range ones as exact strings', async () => {
    const nsTimestamp = 1_700_000_000_000_000_000n; // nanosecond epoch — exceeds MAX_SAFE_INTEGER
    const table = tableFromArrays({
      time: [nsTimestamp, nsTimestamp + 60_000_000_000n],
      open: [1.1, 1.1005],
      high: [1.1006, 1.1007],
      low: [1.0999, 1.1004],
      close: [1.1005, 1.101],
      volume: [10n, 20n], // small bigint — safe to cast to Number
    });
    globalThis.fetch = async () => arrowResponse(table);
    const result = await jetson.getLiveBars({ pair: 'EURUSD' });
    assert.equal(typeof result.bars[0].time, 'string');
    assert.equal(result.bars[0].time, nsTimestamp.toString());
    assert.equal(typeof result.bars[0].volume, 'number');
    assert.equal(result.bars[0].volume, 10);
  });

  it('summary=true returns computed regime/indicators, not raw bars', async () => {
    globalThis.fetch = async () => arrowResponse(makeBarsTable({ count: 40, trendUp: true, drift: 0.002 }));
    const result = await jetson.getLiveBars({ pair: 'EURUSD', summary: true });
    assert.equal(result.bars, undefined);
    assert.equal(typeof result.last_close, 'number');
    assert.equal(typeof result.sma20, 'number');
    assert.equal(typeof result.zscore20, 'number');
    assert.ok(['bullish_expansion', 'range_bound', 'bearish_contraction'].includes(result.regime));
  });

  it('a steady uptrend is classified bullish_expansion', async () => {
    globalThis.fetch = async () => arrowResponse(makeBarsTable({ count: 40, trendUp: true, drift: 0.002 }));
    const result = await jetson.getLiveBars({ pair: 'EURUSD', summary: true });
    assert.equal(result.regime, 'bullish_expansion');
  });

  it('a steady downtrend is classified bearish_contraction', async () => {
    globalThis.fetch = async () => arrowResponse(makeBarsTable({ count: 40, trendUp: false, drift: 0.002 }));
    const result = await jetson.getLiveBars({ pair: 'EURUSD', summary: true });
    assert.equal(result.regime, 'bearish_contraction');
  });
});

describe('jetson core — getSynthesizedContext()', () => {
  beforeEach(() => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/arrow/live_bars/pairs')) return jsonResponse({ pairs: ['EURUSD', 'GBPUSD', 'USDJPY'], timeframes: ['15M'], file_age_seconds: {} });
      if (String(url).includes('/v1/arrow/live_bars')) return arrowResponse(makeBarsTable({ count: 30 }));
      return jsonResponse({}, false, 404);
    };
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('defaults to the top 5 live pairs when none are given', async () => {
    const result = await jetson.getSynthesizedContext({});
    assert.equal(result.pairs.length, 3); // fake feed only has 3
    assert.ok(result.pairs.every((p) => p.regime));
  });

  it('respects an explicit pair list and caps lookback', async () => {
    const result = await jetson.getSynthesizedContext({ pairs: ['EURUSD'], bars: 9999 });
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].pair, 'EURUSD');
    assert.equal(result.bars_analyzed_per_pair, 500); // MAX_LIVE_BARS cap
  });

  it('reports a large token savings estimate vs. raw bars', async () => {
    const result = await jetson.getSynthesizedContext({ pairs: ['EURUSD', 'GBPUSD'] });
    assert.ok(result.token_footprint.savings_pct > 50);
  });

  it('captures per-pair errors without failing the whole call', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('BADPAIR')) throw new Error('boom');
      return arrowResponse(makeBarsTable({ count: 30 }));
    };
    const result = await jetson.getSynthesizedContext({ pairs: ['EURUSD', 'BADPAIR'] });
    const bad = result.pairs.find((p) => p.pair === 'BADPAIR');
    assert.equal(bad.error, 'boom');
  });
});

describe('jetson core — correlateChart()', () => {
  function mockChartState(symbol, resolution) {
    return { _deps: { evaluate: async () => ({ symbol, resolution, chartType: 1, studies: [] }) } };
  }

  beforeEach(() => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/arrow/live_bars/pairs')) return jsonResponse({ pairs: ['EURUSD', 'GBPUSD'], timeframes: ['1M', '5M', '15M', '1H'], file_age_seconds: {} });
      if (String(url).includes('/v1/arrow/live_bars')) return arrowResponse(makeBarsTable({ count: 30 }));
      return jsonResponse({}, false, 404);
    };
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('maps a broker-prefixed FX symbol and a covered resolution, then returns synthesized context', async () => {
    const result = await jetson.correlateChart(mockChartState('OANDA:EURUSD', '15'));
    assert.equal(result.mapped_pair, 'EURUSD');
    assert.equal(result.mapped_tf, '15M');
    assert.equal(result.correlated, true);
    assert.equal(result.jetson.pair, 'EURUSD');
    assert.ok(result.jetson.regime);
  });

  it('strips a slash-separated broker symbol the same way', async () => {
    const result = await jetson.correlateChart(mockChartState('FX_IDC:EUR/USD', '60'));
    assert.equal(result.mapped_pair, 'EURUSD');
    assert.equal(result.mapped_tf, '1H');
    assert.equal(result.correlated, true);
  });

  it('reports no correlation for a non-FX symbol without guessing', async () => {
    const result = await jetson.correlateChart(mockChartState('BATS:AAPL', '15'));
    assert.equal(result.mapped_pair, null);
    assert.equal(result.correlated, false);
    assert.match(result.reason, /doesn't look like an FX pair/);
  });

  it('reports no correlation for a resolution Jetson does not cover, without guessing a nearest match', async () => {
    const result = await jetson.correlateChart(mockChartState('OANDA:EURUSD', 'D'));
    assert.equal(result.mapped_pair, 'EURUSD');
    assert.equal(result.mapped_tf, null);
    assert.equal(result.correlated, false);
    assert.deepEqual(result.available_jetson_timeframes, ['1M', '5M', '15M', '1H']);
  });

  it('an explicit tf override works even on an uncovered resolution', async () => {
    const result = await jetson.correlateChart({ tf: '15M', ...mockChartState('OANDA:EURUSD', 'D') });
    assert.equal(result.mapped_tf, '15M');
    assert.equal(result.correlated, true);
  });

  it('reports no correlation when the mapped pair is not currently live', async () => {
    const result = await jetson.correlateChart(mockChartState('OANDA:USDCHF', '15'));
    assert.equal(result.mapped_pair, 'USDCHF');
    assert.equal(result.correlated, false);
    assert.match(result.reason, /isn't currently streaming/);
    assert.deepEqual(result.jetson_live_pairs, ['EURUSD', 'GBPUSD']);
  });
});

function makeGammaTable(pair, validFrom, { spotMid = 1.09, daysToExpiry = 10 } = {}) {
  const levelNames = ['GAMMA_WEIGHTED', 'GAMMA_1', 'GAMMA_2', 'GAMMA_3', 'GAMMA_4', 'GAMMA_5'];
  const n = levelNames.length;
  return tableFromArrays({
    pair: new Array(n).fill(pair),
    level_name: levelNames,
    level_price: levelNames.map((_, i) => spotMid + (i - 2) * 0.005),
    gamma: levelNames.map((_, i) => 100 - i * 10),
    gamma_rank: [0, 1, 2, 3, 4, 5],
    strike_dist_pct: levelNames.map((_, i) => (i - 2) * 0.5),
    spot_mid: new Array(n).fill(spotMid),
    total_gamma: new Array(n).fill(500),
    gamma_skew_vs_spot: new Array(n).fill(0.12),
    days_to_expiry_used: new Array(n).fill(daysToExpiry),
    expiry_used: new Array(n).fill('2026-10-16'),
    valid_from: new Array(n).fill(validFrom),
  });
}

function makeDealerTable(pair, sessionDate) {
  return tableFromArrays({
    pair: [pair],
    pdh: [1.095],
    pdl: [1.085],
    pdm: [1.09],
    dealers_range_high_20d: [1.1],
    dealers_range_low_20d: [1.08],
    pwh: [1.098],
    pwl: [1.082],
    session_date: [sessionDate],
  });
}

// Drives drawShape's before/create/after evaluate() sequence so each call
// gets a distinct new entity_id, and (when a symbol is given) answers the
// first evaluate() call as if it were chart.getState()'s CDP round trip.
function makeAnnotateDeps({ symbol, resolution } = {}) {
  let stateReturned = symbol === undefined;
  const drawnIds = [];
  let cycle = 0;
  const evaluate = async () => {
    if (!stateReturned) {
      stateReturned = true;
      return { symbol, resolution, chartType: 1, studies: [] };
    }
    cycle++;
    const pos = cycle % 3;
    if (pos === 1) return drawnIds.slice();
    if (pos === 2) return null;
    const id = `shape_${cycle}`;
    drawnIds.push(id);
    return drawnIds.slice();
  };
  return { evaluate, getChartApi: async () => 'window.mockApi' };
}

describe('jetson core — getGammaLevels() / getDealerLevels()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('getGammaLevels keeps only the latest snapshot and sorts weighted magnet first', async () => {
    const older = new Date('2026-09-11T00:00:00Z');
    const newer = new Date('2026-09-11T01:00:00Z');
    // Build one combined table holding both an older and a newer 6-row
    // snapshot for the same pair, so getGammaLevels has to pick the right one.
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const n = 12;
    const levelNames = ['GAMMA_WEIGHTED', 'GAMMA_1', 'GAMMA_2', 'GAMMA_3', 'GAMMA_4', 'GAMMA_5'];
    const combinedTable = tfa({
      pair: new Array(n).fill('EURUSD'),
      level_name: [...levelNames, ...levelNames],
      level_price: [...levelNames.map((_, i) => 1.09 + (i - 2) * 0.005), ...levelNames.map((_, i) => 1.10 + (i - 2) * 0.005)],
      gamma: [...levelNames.map((_, i) => 100 - i * 10), ...levelNames.map((_, i) => 200 - i * 10)],
      gamma_rank: [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5],
      strike_dist_pct: [...levelNames.map((_, i) => (i - 2) * 0.5), ...levelNames.map((_, i) => (i - 2) * 0.4)],
      spot_mid: [...new Array(6).fill(1.09), ...new Array(6).fill(1.10)],
      total_gamma: [...new Array(6).fill(500), ...new Array(6).fill(600)],
      gamma_skew_vs_spot: [...new Array(6).fill(0.1), ...new Array(6).fill(0.2)],
      days_to_expiry_used: [...new Array(6).fill(10), ...new Array(6).fill(9)],
      expiry_used: [...new Array(6).fill('2026-10-16'), ...new Array(6).fill('2026-10-16')],
      valid_from: [...new Array(6).fill(older), ...new Array(6).fill(newer)],
    });
    globalThis.fetch = async () => arrowResponse(combinedTable);

    const result = await jetson.getGammaLevels({ pair: 'EURUSD' });
    assert.equal(result.available, true);
    assert.equal(result.levels.length, 6);
    assert.equal(result.levels[0].level_name, 'GAMMA_WEIGHTED');
    assert.equal(result.spot_mid, 1.1); // from the NEWER snapshot, not the older one
    assert.ok(result.levels.every((l) => l.gamma === 200 - (l.gamma_rank * 10)));
  });

  it('getGammaLevels reports available:false for a pair with no listed options, not an error', async () => {
    // Simulate an empty result set (a minor cross with no gamma data)
    const { tableFromArrays: tfa } = await import('apache-arrow');
    globalThis.fetch = async () => arrowResponse(tfa({ pair: [], level_name: [], level_price: [], gamma: [], gamma_rank: [], strike_dist_pct: [], spot_mid: [], total_gamma: [], gamma_skew_vs_spot: [], days_to_expiry_used: [], expiry_used: [], valid_from: [] }));
    const result = await jetson.getGammaLevels({ pair: 'EURNOK' });
    assert.equal(result.available, false);
    assert.match(result.reason, /no gamma at all|no gamma data|minor crosses/i);
  });

  it('getDealerLevels keeps only the latest session', async () => {
    const newerRow = makeDealerTable('EURUSD', new Date('2026-09-10T00:00:00Z')).toArray()[0];
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const combined = tfa({
      pair: ['EURUSD', 'EURUSD'],
      pdh: [1.0, 1.095],
      pdl: [0.99, 1.085],
      pdm: [0.995, 1.09],
      dealers_range_high_20d: [1.02, 1.1],
      dealers_range_low_20d: [0.97, 1.08],
      pwh: [1.03, 1.098],
      pwl: [0.96, 1.082],
      session_date: [new Date('2026-09-09T00:00:00Z'), new Date('2026-09-10T00:00:00Z')],
    });
    globalThis.fetch = async () => arrowResponse(combined);
    const result = await jetson.getDealerLevels({ pair: 'EURUSD' });
    assert.equal(result.available, true);
    assert.equal(result.levels.pdh, newerRow.pdh);
  });
});

describe('jetson core — annotateKeyLevels()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('draws gamma + dealer levels on the chart for an explicit pair', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('gamma_levels')) return arrowResponse(makeGammaTable('EURUSD', new Date()));
      if (String(url).includes('dealers_levels')) return arrowResponse(makeDealerTable('EURUSD', new Date()));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateKeyLevels({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, true);
    assert.equal(result.lines_drawn, 6 + 7); // 6 gamma levels + 7 dealer fields
    assert.equal(result.lines_failed, 0);
    assert.ok(result.drawn_levels.every((l) => l.entity_id));
  });

  it('defaults to the symbol on the live chart when no pair is given', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('gamma_levels')) return arrowResponse(makeGammaTable('GBPUSD', new Date()));
      if (String(url).includes('dealers_levels')) return arrowResponse(makeDealerTable('GBPUSD', new Date()));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateKeyLevels({ _deps: makeAnnotateDeps({ symbol: 'OANDA:GBPUSD', resolution: '15' }) });
    assert.equal(result.pair, 'GBPUSD');
    assert.equal(result.drawn, true);
  });

  it('reports drawn:false and does not touch the chart when the chart symbol is not FX', async () => {
    const result = await jetson.annotateKeyLevels({ _deps: makeAnnotateDeps({ symbol: 'BATS:AAPL', resolution: '15' }) });
    assert.equal(result.drawn, false);
    assert.match(result.reason, /doesn't look like an FX pair/);
  });

  it('draw:false returns the fetched levels without drawing anything', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('gamma_levels')) return arrowResponse(makeGammaTable('EURUSD', new Date()));
      if (String(url).includes('dealers_levels')) return arrowResponse(makeDealerTable('EURUSD', new Date()));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateKeyLevels({ pair: 'EURUSD', draw: false, _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.gamma.available, true);
    assert.equal(result.dealer.available, true);
  });
});

function makeCotRow(overrides = {}) {
  return {
    pair: 'EURUSD',
    base_ccy: 'EUR',
    quote_ccy: 'USD',
    base_index: 72.5,
    quote_index: 38.2,
    base_commercial_net: -12000,
    quote_commercial_net: 8000,
    base_open_interest: 500000,
    quote_open_interest: 900000,
    institutional_bias: 0.343,
    bias_direction: 'LONG_BASE',
    stale_legs: null,
    is_complete: true,
    report_age_days: 4,
    is_current: true,
    report_date: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('jetson core — getCotSentiment()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function tableFrom(rows) {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const fields = Object.keys(rows[0]);
    const cols = {};
    for (const f of fields) cols[f] = rows.map((r) => r[f]);
    return tfa(cols);
  }

  it('returns the institutional bias for a complete report', async () => {
    globalThis.fetch = async () => arrowResponse(await tableFrom([makeCotRow()]));
    const result = await jetson.getCotSentiment({ pair: 'EURUSD' });
    assert.equal(result.available, true);
    assert.equal(result.bias_direction, 'LONG_BASE');
    assert.equal(result.institutional_bias, 0.343);
    assert.equal(result.base_ccy, 'EUR');
  });

  it('keeps only the most recent report_date', async () => {
    const older = makeCotRow({ report_date: new Date('2026-08-25T00:00:00Z'), institutional_bias: -0.5, bias_direction: 'SHORT_BASE' });
    const newer = makeCotRow({ report_date: new Date('2026-09-01T00:00:00Z'), institutional_bias: 0.343, bias_direction: 'LONG_BASE' });
    globalThis.fetch = async () => arrowResponse(await tableFrom([older, newer]));
    const result = await jetson.getCotSentiment({ pair: 'EURUSD' });
    assert.equal(result.bias_direction, 'LONG_BASE');
  });

  it('NEVER coalesces a stale/incomplete leg to a fake neutral — reports available:false with the stale leg named', async () => {
    const staleRow = makeCotRow({ is_complete: false, institutional_bias: null, bias_direction: null, stale_legs: 'NZD' });
    globalThis.fetch = async () => arrowResponse(await tableFrom([staleRow]));
    const result = await jetson.getCotSentiment({ pair: 'NZDUSD' });
    assert.equal(result.available, false);
    assert.equal(result.stale_legs, 'NZD');
    assert.match(result.reason, /stale/);
    assert.equal(result.bias_direction, undefined); // never fabricated
  });

  it('also refuses a null bias even if is_complete is (incorrectly) true, as a defensive guard', async () => {
    const oddRow = makeCotRow({ is_complete: true, institutional_bias: null });
    globalThis.fetch = async () => arrowResponse(await tableFrom([oddRow]));
    const result = await jetson.getCotSentiment({ pair: 'EURUSD' });
    assert.equal(result.available, false);
  });

  it('reports available:false when the pair has no COT rows at all (empty result set)', async () => {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const empty = tfa({
      pair: [], base_ccy: [], quote_ccy: [], base_index: [], quote_index: [],
      base_commercial_net: [], quote_commercial_net: [], base_open_interest: [], quote_open_interest: [],
      institutional_bias: [], bias_direction: [], stale_legs: [], is_complete: [], report_age_days: [], is_current: [], report_date: [],
    });
    globalThis.fetch = async () => arrowResponse(empty);
    const result = await jetson.getCotSentiment({ pair: 'XXXYYY' });
    assert.equal(result.available, false);
    assert.match(result.reason, /No COT sentiment data/);
  });
});

describe('jetson core — annotateCotSentiment()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function tableFrom(rows) {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const fields = Object.keys(rows[0]);
    const cols = {};
    for (const f of fields) cols[f] = rows.map((r) => r[f]);
    return tfa(cols);
  }

  it('draws a text flag anchored to the latest Jetson close for an explicit pair', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await tableFrom([makeCotRow()]));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateCotSentiment({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, true);
    assert.ok(result.entity_id);
    assert.equal(typeof result.anchored_price, 'number');
    assert.equal(result.sentiment.bias_direction, 'LONG_BASE');
  });

  it('does not draw anything when sentiment is unavailable (stale leg)', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await tableFrom([makeCotRow({ is_complete: false, institutional_bias: null, stale_legs: 'NZD' })]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateCotSentiment({ pair: 'NZDUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.sentiment.available, false);
  });

  it('defaults to the chart symbol when no pair is given', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await tableFrom([makeCotRow({ pair: 'GBPUSD', base_ccy: 'GBP' })]));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateCotSentiment({ _deps: makeAnnotateDeps({ symbol: 'OANDA:GBPUSD', resolution: '15' }) });
    assert.equal(result.pair, 'GBPUSD');
    assert.equal(result.drawn, true);
  });

  it('draw:false returns the sentiment without touching the chart', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await tableFrom([makeCotRow()]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateCotSentiment({ pair: 'EURUSD', draw: false, _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.sentiment.available, true);
  });
});

function makeRegimeRow(overrides = {}) {
  return {
    pair: 'EURUSD',
    state: 'BULL',
    timestamp: new Date('2026-09-11T01:00:00Z'),
    confidence: 0.82,
    vocabulary: 'directional_v1',
    ...overrides,
  };
}

async function makeRegimeTable(rows) {
  const { tableFromArrays: tfa } = await import('apache-arrow');
  const fields = Object.keys(rows[0]);
  const cols = {};
  for (const f of fields) cols[f] = rows.map((r) => r[f]);
  return tfa(cols);
}

describe('jetson core — getDirectionalRegime() / getVolatilityRegime()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('filters strictly on vocabulary and never mixes the two classifiers', async () => {
    const rows = [
      makeRegimeRow({ vocabulary: 'directional_v1', state: 'BULL', timestamp: new Date('2026-09-11T01:00:00Z') }),
      makeRegimeRow({ vocabulary: 'volatility_phase_v1', state: 'EXPANSION', timestamp: new Date('2026-09-11T01:00:00Z') }),
    ];
    globalThis.fetch = async () => arrowResponse(await makeRegimeTable(rows));

    const directional = await jetson.getDirectionalRegime({ pair: 'EURUSD' });
    assert.equal(directional.available, true);
    assert.equal(directional.state, 'BULL');
    assert.equal(directional.vocabulary, 'directional_v1');

    const volatility = await jetson.getVolatilityRegime({ pair: 'EURUSD' });
    assert.equal(volatility.available, true);
    assert.equal(volatility.state, 'EXPANSION');
    assert.equal(volatility.vocabulary, 'volatility_phase_v1');
  });

  it('keeps only the latest row per vocabulary', async () => {
    const rows = [
      makeRegimeRow({ state: 'BEAR', timestamp: new Date('2026-09-10T00:00:00Z') }),
      makeRegimeRow({ state: 'BULL', timestamp: new Date('2026-09-11T01:00:00Z') }),
    ];
    globalThis.fetch = async () => arrowResponse(await makeRegimeTable(rows));
    const directional = await jetson.getDirectionalRegime({ pair: 'EURUSD' });
    assert.equal(directional.state, 'BULL');
  });

  it('flags EXPANSION as the boring base rate but COMPRESSION as a rare/notable reading', async () => {
    globalThis.fetch = async () => arrowResponse(await makeRegimeTable([makeRegimeRow({ vocabulary: 'volatility_phase_v1', state: 'EXPANSION' })]));
    const expansion = await jetson.getVolatilityRegime({ pair: 'EURUSD' });
    assert.match(expansion.note, /base rate/);

    globalThis.fetch = async () => arrowResponse(await makeRegimeTable([makeRegimeRow({ vocabulary: 'volatility_phase_v1', state: 'COMPRESSION' })]));
    const compression = await jetson.getVolatilityRegime({ pair: 'EURUSD' });
    assert.match(compression.note, /rare/);
  });

  it('reports available:false without guessing when a vocabulary has no rows for the pair', async () => {
    globalThis.fetch = async () => arrowResponse(await makeRegimeTable([makeRegimeRow({ vocabulary: 'directional_v1' })]));
    const volatility = await jetson.getVolatilityRegime({ pair: 'EURUSD' });
    assert.equal(volatility.available, false);
    assert.match(volatility.reason, /volatility_phase_v1/);
  });
});

describe('jetson core — annotateRegimeShading()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchWith(regimeRows) {
    return async (url) => {
      if (String(url).includes('markov_regime_log')) return arrowResponse(await makeRegimeTable(regimeRows));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 50 }));
      return jsonResponse({}, false, 404);
    };
  }

  it('draws both a directional background rectangle and a volatility text flag as separate shapes', async () => {
    globalThis.fetch = mockFetchWith([
      makeRegimeRow({ vocabulary: 'directional_v1', state: 'BULL' }),
      makeRegimeRow({ vocabulary: 'volatility_phase_v1', state: 'COMPRESSION' }),
    ]);
    const result = await jetson.annotateRegimeShading({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, true);
    assert.equal(result.drawn_shapes.length, 2);
    assert.equal(result.drawn_shapes[0].type, 'directional_background');
    assert.equal(result.drawn_shapes[1].type, 'volatility_flag');
    assert.match(result.note, /orthogonal/);
  });

  it('still draws the available axis when the other has no data', async () => {
    globalThis.fetch = mockFetchWith([makeRegimeRow({ vocabulary: 'directional_v1', state: 'SIDEWAYS' })]);
    const result = await jetson.annotateRegimeShading({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, true);
    assert.equal(result.drawn_shapes.length, 1);
    assert.equal(result.drawn_shapes[0].type, 'directional_background');
    assert.equal(result.volatility.available, false);
  });

  it('drawn:false when neither axis has data, without touching the chart', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('markov_regime_log')) return arrowResponse(await makeRegimeTable([makeRegimeRow({ vocabulary: 'some_other_classifier' })]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateRegimeShading({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.directional.available, false);
    assert.equal(result.volatility.available, false);
  });

  it('defaults to the chart symbol when no pair is given', async () => {
    globalThis.fetch = mockFetchWith([makeRegimeRow({ pair: 'GBPUSD', vocabulary: 'directional_v1', state: 'BEAR' })]);
    const result = await jetson.annotateRegimeShading({ _deps: makeAnnotateDeps({ symbol: 'OANDA:GBPUSD', resolution: '15' }) });
    assert.equal(result.pair, 'GBPUSD');
    assert.equal(result.drawn, true);
  });

  it('draw:false returns both regimes without drawing anything', async () => {
    globalThis.fetch = mockFetchWith([makeRegimeRow({ vocabulary: 'directional_v1', state: 'BULL' })]);
    const result = await jetson.annotateRegimeShading({ pair: 'EURUSD', draw: false, _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.directional.available, true);
  });
});

function makeConfluenceRow(overrides = {}) {
  return {
    generated_at: new Date('2026-09-11T02:00:00Z'),
    pair: 'EURUSD',
    draw_direction: 'UP',
    draw_confidence: 0.61,
    strength: 0.72,
    agreement: '2/4',
    n_layers: 4,
    n_layers_stale: 0,
    today_high_impact: false,
    week_high_events: 1,
    event_flags: 'none',
    conflicts: 'none',
    molding: 'trend_following',
    ...overrides,
  };
}

function makeConfluenceLayerRow(overrides = {}) {
  return {
    generated_at: new Date('2026-09-11T02:00:00Z'),
    pair: 'EURUSD',
    layer: 'momentum',
    direction: 'UP',
    weight: 0.5,
    damped_weight: 0.5,
    age_h: 1.0,
    stale: false,
    evidence: 'ema_cross',
    ...overrides,
  };
}

async function makeTableFromRows(rows) {
  const { tableFromArrays: tfa } = await import('apache-arrow');
  const fields = Object.keys(rows[0]);
  const cols = {};
  for (const f of fields) cols[f] = rows.map((r) => r[f]);
  return tfa(cols);
}

describe('jetson core — getConfluence() / getConfluenceLayers()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('getConfluence returns the headline call with staleness context, never labeling blend_weight a probability', async () => {
    globalThis.fetch = async () => arrowResponse(await makeTableFromRows([makeConfluenceRow()]));
    const result = await jetson.getConfluence({ pair: 'EURUSD' });
    assert.equal(result.available, true);
    assert.equal(result.draw_direction, 'UP');
    assert.equal(result.agreement, '2/4');
    assert.equal(result.n_layers, 4);
    assert.equal(result.n_layers_stale, 0);
    assert.equal(result.n_layers_fresh, 4);
    assert.equal(result.blend_weight, 0.61);
    assert.match(result.note, /not a probability/);
  });

  it('getConfluence keeps only the latest generated_at run', async () => {
    const older = makeConfluenceRow({ generated_at: new Date('2026-09-10T00:00:00Z'), draw_direction: 'DOWN' });
    const newer = makeConfluenceRow({ generated_at: new Date('2026-09-11T02:00:00Z'), draw_direction: 'UP' });
    globalThis.fetch = async () => arrowResponse(await makeTableFromRows([older, newer]));
    const result = await jetson.getConfluence({ pair: 'EURUSD' });
    assert.equal(result.draw_direction, 'UP');
  });

  it('getConfluence reports available:false for a pair with no confluence rows', async () => {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const empty = tfa({
      generated_at: [], pair: [], draw_direction: [], draw_confidence: [], strength: [], agreement: [],
      n_layers: [], n_layers_stale: [], today_high_impact: [], week_high_events: [], event_flags: [], conflicts: [], molding: [],
    });
    globalThis.fetch = async () => arrowResponse(empty);
    const result = await jetson.getConfluence({ pair: 'EURUSD' });
    assert.equal(result.available, false);
  });

  it('getConfluenceLayers returns only the most recent run\'s layers, preserving damped_weight:0 as-is', async () => {
    const rows = [
      makeConfluenceLayerRow({ layer: 'momentum', damped_weight: 0.5 }),
      makeConfluenceLayerRow({ layer: 'seasonality', damped_weight: 0, stale: true, age_h: 200 }),
    ];
    globalThis.fetch = async () => arrowResponse(await makeTableFromRows(rows));
    const result = await jetson.getConfluenceLayers({ pair: 'EURUSD' });
    assert.equal(result.available, true);
    assert.equal(result.layers.length, 2);
    const seasonality = result.layers.find((l) => l.layer === 'seasonality');
    assert.equal(seasonality.damped_weight, 0);
    assert.equal(seasonality.stale, true);
  });
});

describe('jetson core — annotateConfluenceBadge()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchWith(confluenceRows) {
    return async (url) => {
      if (String(url).includes('/v1/arrow/confluence?') || String(url).includes('/v1/arrow/confluence&')) return arrowResponse(await makeTableFromRows(confluenceRows));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
  }

  it('draws a badge whose text surfaces staleness explicitly', async () => {
    globalThis.fetch = mockFetchWith([makeConfluenceRow({ n_layers: 4, n_layers_stale: 2 })]);
    const result = await jetson.annotateConfluenceBadge({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, true);
    assert.ok(result.entity_id);
    assert.equal(result.confluence.n_layers_stale, 2);
  });

  it('does not draw when confluence is unavailable', async () => {
    globalThis.fetch = async () => jsonResponse({}, false, 404);
    // A 404 makes jetsonFetchArrowRows throw; getConfluence doesn't catch it,
    // so annotateConfluenceBadge should propagate rather than silently drawing.
    await assert.rejects(() => jetson.annotateConfluenceBadge({ pair: 'EURUSD', _deps: makeAnnotateDeps() }));
  });

  it('defaults to the chart symbol when no pair is given', async () => {
    globalThis.fetch = mockFetchWith([makeConfluenceRow({ pair: 'GBPUSD' })]);
    const result = await jetson.annotateConfluenceBadge({ _deps: makeAnnotateDeps({ symbol: 'OANDA:GBPUSD', resolution: '15' }) });
    assert.equal(result.pair, 'GBPUSD');
    assert.equal(result.drawn, true);
  });

  it('draw:false returns the confluence data without drawing anything', async () => {
    globalThis.fetch = mockFetchWith([makeConfluenceRow()]);
    const result = await jetson.annotateConfluenceBadge({ pair: 'EURUSD', draw: false, _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.confluence.available, true);
  });
});

function makeCotExtremeRow(overrides = {}) {
  return {
    currency: 'EUR',
    valid_from: new Date('2026-09-01T00:00:00Z'),
    valid_to: new Date('2026-09-08T00:00:00Z'),
    commercial_net: -50000,
    open_interest: 700000,
    cot_index_6mo: 62.5,
    oi_index_6mo: 40,
    cot_index_1yr: 71.2,
    oi_index_1yr: 45,
    cot_index_4yr: 55,
    oi_index_4yr: 50,
    cot_index_8yr: 60,
    oi_index_8yr: 52,
    cot_index_12yr: 58,
    oi_index_12yr: 51,
    report_date: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCalendarRow(overrides = {}) {
  return {
    date: new Date(Date.now() + 24 * 3600 * 1000),
    title: 'ECB Rate Decision',
    currency: 'EUR',
    impact: 'high',
    actual: '',
    forecast: '4.00%',
    previous: '3.75%',
    source: 'forex_factory',
    event_hash: 'abc123',
    ...overrides,
  };
}

function makeCarryRow(overrides = {}) {
  return {
    pair: 'EURUSD',
    carry: 0.4,
    carry_positive: true,
    carry_zscore_20d: 0.5,
    carry_zscore_90d: 0.3,
    carry_momentum_20d: 0.01,
    carry_momentum_5d: 0.002,
    date: new Date('2026-09-10T00:00:00Z'),
    ...overrides,
  };
}

function makeRiskRow(overrides = {}) {
  return {
    pulled_at: new Date('2026-09-11T02:00:00Z'),
    pair: 'EURUSD',
    tf: '1D',
    conditional_vol: 0.28,
    long_run_vol: 0.44,
    persistence: 0.99,
    vol_percentile: 0.1,
    covol_pc1: -0.11,
    covol_pc1_percentile: 0.2,
    covol_variance_explained: 0.76,
    illiq_composite: 0.000005,
    illiq_percentile: 0.9,
    model_dispersion: 0.005,
    model_dispersion_percentile: 0.8,
    cot_report_date: new Date('2026-09-01'),
    cot_non_commercial_zscore: -1.3,
    cot_is_extreme: false,
    cot_extreme_direction: 'NORMAL',
    ...overrides,
  };
}

describe('jetson core — getCurrencyNode()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns COT extremes and upcoming events, excluding holidays from the event list', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_extremes')) return arrowResponse(await makeTableFromRows([makeCotExtremeRow()]));
      if (String(url).includes('calendar_events')) {
        return arrowResponse(await makeTableFromRows([
          makeCalendarRow({ impact: 'high', title: 'ECB Rate Decision' }),
          makeCalendarRow({ impact: 'HOLIDAY', title: 'Bank Holiday', date: new Date(Date.now() + 48 * 3600 * 1000) }),
        ]));
      }
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyNode({ currency: 'eur' });
    assert.equal(result.currency, 'EUR');
    assert.equal(result.cot.available, true);
    assert.equal(result.cot.cot_index_1yr, 71.2);
    assert.equal(result.upcoming_events.length, 1);
    assert.equal(result.upcoming_events[0].impact, 'high');
    assert.equal(result.next_high_impact_event.title, 'ECB Rate Decision');
    assert.equal(result.upcoming_holidays.length, 1);
  });

  it('reports cot.available:false for USD without throwing (USD has no COT contract of its own)', async () => {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const emptyCotExtremes = tfa({
      currency: [], valid_from: [], valid_to: [], commercial_net: [], open_interest: [],
      cot_index_6mo: [], oi_index_6mo: [], cot_index_1yr: [], oi_index_1yr: [], cot_index_4yr: [], oi_index_4yr: [],
      cot_index_8yr: [], oi_index_8yr: [], cot_index_12yr: [], oi_index_12yr: [], report_date: [],
    });
    globalThis.fetch = async (url) => {
      if (String(url).includes('cot_extremes')) return arrowResponse(emptyCotExtremes);
      if (String(url).includes('calendar_events')) return arrowResponse(await makeTableFromRows([makeCalendarRow({ currency: 'USD' })]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyNode({ currency: 'USD' });
    assert.equal(result.cot.available, false);
    assert.match(result.cot.reason, /USD/);
  });
});

describe('jetson core — getCurrencyPairEdge()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('combines carry, risk (best-fit timeframe), and COT sentiment for a pair', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('carry_features')) return arrowResponse(await makeTableFromRows([makeCarryRow()]));
      if (String(url).includes('fx_risk_snapshot')) {
        return arrowResponse(await makeTableFromRows([
          makeRiskRow({ tf: '15M', covol_pc1: null, covol_variance_explained: null }),
          makeRiskRow({ tf: '1D', covol_pc1: -0.11, covol_variance_explained: 0.76 }),
          makeRiskRow({ tf: '1H', covol_pc1: 0.02, covol_variance_explained: 0.55 }),
        ]));
      }
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await makeTableFromRows([makeCotRow()]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyPairEdge({ pair: 'EURUSD' });
    assert.equal(result.carry.available, true);
    assert.equal(result.carry.carry, 0.4);
    assert.equal(result.risk.available, true);
    assert.equal(result.risk.by_timeframe.length, 3);
    assert.equal(result.risk.primary_covol.tf, '1D'); // best covol_variance_explained, not just first row
    assert.equal(result.cot.available, true);
  });

  it('reports carry.available:false without throwing when carry data is missing', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('carry_features')) return jsonResponse({}, false, 404);
      if (String(url).includes('fx_risk_snapshot')) return arrowResponse(await makeTableFromRows([makeRiskRow()]));
      if (String(url).includes('cot_pair_sentiment')) return arrowResponse(await makeTableFromRows([makeCotRow()]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyPairEdge({ pair: 'EURUSD' });
    assert.equal(result.carry.available, false);
    assert.equal(result.risk.available, true);
  });
});

describe('jetson core — getCurrencyGraph()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('builds nodes for the default G4 currencies and edges for live pairs among them', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('cot_extremes')) return arrowResponse(await makeTableFromRows([makeCotExtremeRow()]));
      if (u.includes('calendar_events')) return arrowResponse(await makeTableFromRows([makeCalendarRow()]));
      if (u.includes('carry_features')) return arrowResponse(await makeTableFromRows([makeCarryRow()]));
      if (u.includes('fx_risk_snapshot')) return arrowResponse(await makeTableFromRows([makeRiskRow()]));
      if (u.includes('cot_pair_sentiment')) return arrowResponse(await makeTableFromRows([makeCotRow()]));
      if (u.includes('live_bars/pairs')) return jsonResponse({ pairs: ['EURUSD', 'GBPUSD', 'EURGBP', 'USDJPY', 'AUDNZD'], timeframes: ['15M'], file_age_seconds: {} });
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyGraph({});
    assert.deepEqual(result.currencies, ['USD', 'EUR', 'GBP', 'JPY']);
    assert.equal(result.nodes.length, 4);
    // AUDNZD should be excluded — neither AUD nor NZD is in the default currency set
    const edgePairs = result.edges.map((e) => e.pair);
    assert.ok(edgePairs.includes('EURUSD'));
    assert.ok(edgePairs.includes('EURGBP'));
    assert.ok(!edgePairs.includes('AUDNZD'));
    assert.match(result.note, /FX-only/);
  });

  it('respects an explicit currencies list and explicit pairs override', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('cot_extremes')) return arrowResponse(await makeTableFromRows([makeCotExtremeRow()]));
      if (u.includes('calendar_events')) return arrowResponse(await makeTableFromRows([makeCalendarRow()]));
      if (u.includes('carry_features')) return arrowResponse(await makeTableFromRows([makeCarryRow()]));
      if (u.includes('fx_risk_snapshot')) return arrowResponse(await makeTableFromRows([makeRiskRow()]));
      if (u.includes('cot_pair_sentiment')) return arrowResponse(await makeTableFromRows([makeCotRow()]));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.getCurrencyGraph({ currencies: ['AUD', 'NZD'], pairs: ['AUDNZD'] });
    assert.deepEqual(result.currencies, ['AUD', 'NZD']);
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].pair, 'AUDNZD');
  });
});

function findSundayUTC(afterMs) {
  let t = afterMs;
  while (new Date(t).getUTCDay() !== 0) t += 86400000;
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// Builds candles_1h-shaped rows with a deterministic, known pattern: Monday
// bars always close up, Tuesday bars always close down, everything else
// flat — so the computed seasonality stats can be asserted precisely rather
// than just "some number came back".
function makeSeasonalCandles({ days = 21 } = {}) {
  const start = findSundayUTC(Date.now() - (days + 7) * 86400000);
  const rows = [];
  for (let h = 0; h < days * 24; h++) {
    const t = start + h * 3600000;
    const dow = new Date(t).getUTCDay();
    const open = 1.1;
    let close = open;
    if (dow === 1) close = open + 0.001; // Monday: reliably up
    else if (dow === 2) close = open - 0.001; // Tuesday: reliably down
    rows.push({
      pair: 'EURUSD',
      open,
      high: Math.max(open, close) + 0.0002,
      low: Math.min(open, close) - 0.0002,
      close,
      volume: null,
      tick_count: null,
      ohlc_source: 'twelvedata',
      volume_source: null,
      time: t,
    });
  }
  return rows;
}

describe('jetson core — getSeasonality()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('computes real day-of-week stats with correct sign and sample size', async () => {
    const rows = makeSeasonalCandles({ days: 21 });
    globalThis.fetch = async () => arrowResponse(await makeTableFromRows(rows));
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.available, true);
    assert.equal(result.computed_from, 'candles_1h (not a native Jetson dataset — computed here)');

    const monday = result.by_day_of_week.find((d) => d.day === 'Monday');
    const tuesday = result.by_day_of_week.find((d) => d.day === 'Tuesday');
    const wednesday = result.by_day_of_week.find((d) => d.day === 'Wednesday');
    assert.ok(monday.avg_return_pct > 0, `expected positive Monday return, got ${monday.avg_return_pct}`);
    assert.ok(tuesday.avg_return_pct < 0, `expected negative Tuesday return, got ${tuesday.avg_return_pct}`);
    assert.equal(wednesday.avg_return_pct, 0);
    assert.equal(monday.n, 3 * 24); // 3 Mondays in a 21-day window, 24 bars each
  });

  it('reports available:false rather than a misleading result when history is too thin', async () => {
    const rows = makeSeasonalCandles({ days: 2 });
    globalThis.fetch = async () => arrowResponse(await makeTableFromRows(rows));
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.available, false);
    assert.match(result.reason, /not enough history/);
  });

  it('reports available:false for a pair with no candles_1h history at all', async () => {
    const { tableFromArrays: tfa } = await import('apache-arrow');
    const empty = tfa({ pair: [], open: [], high: [], low: [], close: [], volume: [], tick_count: [], ohlc_source: [], volume_source: [], time: [] });
    globalThis.fetch = async () => arrowResponse(empty);
    const result = await jetson.getSeasonality({ pair: 'EURUSD' });
    assert.equal(result.available, false);
  });
});

// Every bar reliably closes up, regardless of day — makes "today"'s
// historical direction deterministic (always UP) no matter which real day
// of the week the test suite actually runs on.
function makeAllUpCandles({ days = 21 } = {}) {
  const start = findSundayUTC(Date.now() - (days + 7) * 86400000);
  const rows = [];
  for (let h = 0; h < days * 24; h++) {
    const t = start + h * 3600000;
    const open = 1.1;
    const close = open + 0.001;
    rows.push({ pair: 'EURUSD', open, high: close + 0.0002, low: open - 0.0002, close, volume: null, tick_count: null, ohlc_source: 'twelvedata', volume_source: null, time: t });
  }
  return rows;
}

describe('jetson core — getSeasonality() confluence weekly_profile cross-reference', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchWith(weeklyProfileRow) {
    const candles = makeAllUpCandles({ days: 21 });
    return async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(candles));
      if (String(url).includes('confluence_layers')) return arrowResponse(await makeTableFromRows([weeklyProfileRow]));
      return jsonResponse({}, false, 404);
    };
  }

  it('parses the weekly_profile evidence string and flags AGREE when directions match', async () => {
    globalThis.fetch = mockFetchWith(makeConfluenceLayerRow({
      layer: 'weekly_profile', direction: 'UP', weight: 1.2, damped_weight: 1.1, stale: false,
      evidence: 'week_profile quiet_week: bias=+0.42, events_high=0, computed=2026-09-11',
    }));
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.available, true);
    const wp = result.confluence_weekly_profile;
    assert.equal(wp.available, true);
    assert.equal(wp.direction, 'UP');
    assert.equal(wp.model_bias, 0.42);
    assert.equal(wp.week_tag, 'quiet_week');
    assert.equal(wp.high_impact_events_this_week, 0);
    assert.equal(wp.trust_ratio, 0.917); // round(1.1 / 1.2, 3)
    assert.equal(result.today_vs_confluence_agreement, 'AGREE'); // historical is always UP in this fixture
  });

  it('flags DIFFER when the confluence weekly bias points the opposite way', async () => {
    globalThis.fetch = mockFetchWith(makeConfluenceLayerRow({
      layer: 'weekly_profile', direction: 'DOWN', weight: 1.0, damped_weight: 0.8, stale: false,
      evidence: 'week_profile event_week: bias=-0.55, events_high=2, computed=2026-09-11',
    }));
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.confluence_weekly_profile.direction, 'DOWN');
    assert.equal(result.confluence_weekly_profile.week_tag, 'event_week');
    assert.equal(result.today_vs_confluence_agreement, 'DIFFER');
  });

  it('falls back to the raw evidence string when it does not match the expected shape', async () => {
    globalThis.fetch = mockFetchWith(makeConfluenceLayerRow({ layer: 'weekly_profile', direction: 'UP', evidence: 'some future format we do not parse' }));
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.confluence_weekly_profile.evidence_raw, 'some future format we do not parse');
    assert.equal(result.confluence_weekly_profile.model_bias, undefined);
  });

  it('is available:false without crashing seasonality when confluence data is unreachable', async () => {
    const candles = makeAllUpCandles({ days: 21 });
    globalThis.fetch = async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(candles));
      return jsonResponse({}, false, 404); // confluence_layers unreachable
    };
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.available, true); // seasonality itself still works
    assert.equal(result.confluence_weekly_profile.available, false);
    assert.equal(result.today_vs_confluence_agreement, null);
  });

  it('is N/A (not AGREE/DIFFER) when there is no weekly_profile layer in the latest run', async () => {
    globalThis.fetch = mockFetchWith(makeConfluenceLayerRow({ layer: 'momentum', direction: 'UP' })); // no weekly_profile row at all
    const result = await jetson.getSeasonality({ pair: 'EURUSD', lookbackDays: 30 });
    assert.equal(result.confluence_weekly_profile.available, false);
    assert.equal(result.today_vs_confluence_agreement, null);
  });
});

describe('jetson core — annotateSeasonality() confluence weekly_profile weighting', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('weaves the model week bias and trust weighting into the drawn flag text, and colors DIFFER amber', async () => {
    const candles = makeAllUpCandles({ days: 21 }); // historical is always UP in this fixture
    globalThis.fetch = async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(candles));
      if (String(url).includes('confluence_layers')) {
        return arrowResponse(await makeTableFromRows([makeConfluenceLayerRow({
          layer: 'weekly_profile', direction: 'DOWN', weight: 1.0, damped_weight: 0.6, stale: true,
          evidence: 'week_profile event_week: bias=-0.55, events_high=2, computed=2026-09-11',
        })]));
      }
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };

    // Capture the actual JS evaluated by drawShape() so the drawn text/color
    // can be asserted precisely, not just "something got drawn".
    const capturedCalls = [];
    const drawnIds = [];
    let cycle = 0;
    const evaluate = async (js) => {
      capturedCalls.push(js);
      cycle += 1;
      const pos = cycle % 3;
      if (pos === 1) return drawnIds.slice();
      if (pos === 2) return null;
      const id = `shape_${cycle}`;
      drawnIds.push(id);
      return drawnIds.slice();
    };
    const _deps = { evaluate, getChartApi: async () => 'window.mockApi' };

    const result = await jetson.annotateSeasonality({ pair: 'EURUSD', _deps });
    assert.equal(result.drawn, true);
    assert.equal(result.seasonality.today_vs_confluence_agreement, 'DIFFER');

    const createCall = capturedCalls.find((js) => js.includes('createShape'));
    assert.ok(createCall, 'expected a createShape evaluate() call');
    assert.match(createCall, /Model week bias: DOWN/);
    assert.match(createCall, /trust 60%/); // round(0.6 / 1.0, 3) * 100
    assert.match(createCall, /stale/);
    assert.match(createCall, /\[DIFFER\]/);
    assert.match(createCall, /#f59e0b/); // amber for a directional conflict, not the usual green/red
  });
});

describe('jetson core — annotateSeasonality()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('draws today\'s seasonal read when today has samples', async () => {
    const rows = makeSeasonalCandles({ days: 21 });
    globalThis.fetch = async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(rows));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateSeasonality({ pair: 'EURUSD', _deps: makeAnnotateDeps() });
    // Whether it draws depends on whether "today" (real UTC day, test runs any day
    // of the week) has samples — every day of the week is represented in the
    // 21-day fixture, so it should always have a non-zero bucket.
    assert.equal(result.drawn, true);
    assert.ok(result.entity_id);
  });

  it('draw:false returns the seasonality data without drawing anything', async () => {
    const rows = makeSeasonalCandles({ days: 21 });
    globalThis.fetch = async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(rows));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateSeasonality({ pair: 'EURUSD', draw: false, _deps: makeAnnotateDeps() });
    assert.equal(result.drawn, false);
    assert.equal(result.seasonality.available, true);
  });

  it('defaults to the chart symbol when no pair is given', async () => {
    const rows = makeSeasonalCandles({ days: 21 }).map((r) => ({ ...r, pair: 'GBPUSD' }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('candles_1h')) return arrowResponse(await makeTableFromRows(rows));
      if (String(url).includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
    const result = await jetson.annotateSeasonality({ _deps: makeAnnotateDeps({ symbol: 'OANDA:GBPUSD', resolution: '15' }) });
    assert.equal(result.pair, 'GBPUSD');
    assert.equal(result.drawn, true);
  });
});

// Drives pane.list()/pane.focus()'s real evaluate() JS contract (matched by
// pattern in the JS source string, the same way the real CDP call would be
// distinguished) combined with drawShape's before/create/after cycle — so
// a single _deps.evaluate mock can stand in for a whole multi-pane session.
function makeMultiPaneDeps({ panes, activeIndex }) {
  const drawnIds = [];
  let drawCycle = 0;
  const evaluate = async (js) => {
    if (js.includes('panes.push')) {
      return { layout: '4', chart_count: panes.length, active_index: activeIndex, panes };
    }
    const focusMatch = /if \((\d+) >= all\.length\)/.exec(js);
    if (focusMatch) {
      const idx = Number(focusMatch[1]);
      if (idx >= panes.length) return { error: `Pane index ${idx} out of range (have ${panes.length} panes)` };
      return { focused: idx, total: panes.length };
    }
    // Fall through to drawShape's before/create/after cycle.
    drawCycle += 1;
    const pos = drawCycle % 3;
    if (pos === 1) return drawnIds.slice();
    if (pos === 2) return null;
    const id = `shape_${drawCycle}`;
    drawnIds.push(id);
    return drawnIds.slice();
  };
  return { evaluate, getChartApi: async () => 'window.mockApi' };
}

describe('jetson core — annotateConfluenceBadgesAllPanes()', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockConfluenceFetchFor(pairsToConfluence) {
    return async (url) => {
      const u = String(url);
      for (const [pair, direction] of Object.entries(pairsToConfluence)) {
        if (u.includes('confluence?pair=' + pair)) return arrowResponse(await makeTableFromRows([makeConfluenceRow({ pair, draw_direction: direction })]));
      }
      if (u.includes('live_bars')) return arrowResponse(makeBarsTable({ count: 5 }));
      return jsonResponse({}, false, 404);
    };
  }

  it('draws a badge on every FX pane, skips non-FX panes, and restores the original active pane', async () => {
    const panes = [
      { index: 0, symbol: 'OANDA:EURUSD', resolution: '15' },
      { index: 1, symbol: 'OANDA:GBPUSD', resolution: '15' },
      { index: 2, symbol: 'BATS:AAPL', resolution: 'D' }, // non-FX — should be skipped
    ];
    globalThis.fetch = mockConfluenceFetchFor({ EURUSD: 'UP', GBPUSD: 'DOWN' });
    const deps = makeMultiPaneDeps({ panes, activeIndex: 1 });

    const result = await jetson.annotateConfluenceBadgesAllPanes({ _deps: deps });

    assert.equal(result.drawn, true);
    assert.equal(result.panes_annotated, 2);
    assert.equal(result.panes_skipped, 1);
    assert.equal(result.restored_active_index, 1);

    const eurusdResult = result.results.find((r) => r.index === 0);
    assert.equal(eurusdResult.drawn, true);
    assert.equal(eurusdResult.pair, 'EURUSD');

    const aaplResult = result.results.find((r) => r.index === 2);
    assert.equal(aaplResult.drawn, false);
    assert.match(aaplResult.reason, /doesn't look like an FX pair/);
  });

  it('reports drawn:false with a clear reason on a single-pane layout, without touching the chart', async () => {
    const panes = [{ index: 0, symbol: 'OANDA:EURUSD', resolution: '15' }];
    const deps = makeMultiPaneDeps({ panes, activeIndex: 0 });
    const result = await jetson.annotateConfluenceBadgesAllPanes({ _deps: deps });
    assert.equal(result.drawn, false);
    assert.match(result.reason, /Only 1 pane/);
  });

  it('draw:false fetches confluence for every pane without drawing anything', async () => {
    const panes = [
      { index: 0, symbol: 'OANDA:EURUSD', resolution: '15' },
      { index: 1, symbol: 'OANDA:GBPUSD', resolution: '15' },
    ];
    globalThis.fetch = mockConfluenceFetchFor({ EURUSD: 'UP', GBPUSD: 'DOWN' });
    const deps = makeMultiPaneDeps({ panes, activeIndex: 0 });
    const result = await jetson.annotateConfluenceBadgesAllPanes({ draw: false, _deps: deps });
    assert.equal(result.drawn, false);
    assert.equal(result.results.every((r) => r.confluence?.available), true);
  });

  it('continues annotating remaining panes when one pane errors out', async () => {
    const panes = [
      { index: 0, symbol: 'OANDA:EURUSD', resolution: '15' },
      { index: 1, error: 'no main series' },
      { index: 2, symbol: 'OANDA:GBPUSD', resolution: '15' },
    ];
    globalThis.fetch = mockConfluenceFetchFor({ EURUSD: 'UP', GBPUSD: 'DOWN' });
    const deps = makeMultiPaneDeps({ panes, activeIndex: 0 });
    const result = await jetson.annotateConfluenceBadgesAllPanes({ _deps: deps });
    assert.equal(result.panes_annotated, 2);
    const errored = result.results.find((r) => r.index === 1);
    assert.equal(errored.drawn, false);
    assert.match(errored.reason, /Could not read this pane's symbol/);
  });
});
