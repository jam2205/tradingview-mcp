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
