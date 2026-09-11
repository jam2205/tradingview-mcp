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
