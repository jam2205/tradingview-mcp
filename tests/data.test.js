/**
 * Tests for src/core/data.js's findSwingPoints() — the N-bar fractal swing
 * high/low finder. Uses _deps injection to mock the CDP evaluate() call, the
 * same pattern sanitization.test.js uses for chart.js/drawing.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSwingPoints } from '../src/core/data.js';

// Flat baseline bars with one deliberate spike-high at `highIndex` and one
// deliberate dip-low at `lowIndex`, so the exact expected swing points are
// known in advance rather than inferred after the fact.
function makeBars({ count = 21, highIndex = 10, lowIndex = 15 } = {}) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    bars.push({ time: 1000 + i * 60, open: 1.1, high: 1.101, low: 1.099, close: 1.1, volume: 10 });
  }
  if (highIndex != null) bars[highIndex].high = 1.2; // far above every other bar's high
  if (lowIndex != null) bars[lowIndex].low = 1.0; // far below every other bar's low
  return bars;
}

function depsWithBars(bars) {
  return { evaluate: async () => ({ bars }) };
}

describe('findSwingPoints()', () => {
  it('finds the exact deliberate swing high and swing low, and nothing else', async () => {
    const bars = makeBars({ count: 21, highIndex: 10, lowIndex: 15 });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });

    assert.equal(result.success, true);
    assert.equal(result.window, 5);
    assert.equal(result.bar_count, 21);

    const highs = result.swings.filter((s) => s.type === 'swing_high');
    const lows = result.swings.filter((s) => s.type === 'swing_low');
    assert.equal(highs.length, 1);
    assert.equal(lows.length, 1);
    assert.equal(highs[0].bar_index, 10);
    assert.equal(highs[0].price, 1.2);
    assert.equal(highs[0].time, bars[10].time);
    assert.equal(highs[0].time_utc, new Date(bars[10].time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
    assert.equal(lows[0].bar_index, 15);
    assert.equal(lows[0].price, 1.0);
  });

  it('gives a tied low to its first bar: one swing, not none', async () => {
    const bars = makeBars({ count: 21, highIndex: null, lowIndex: 10 });
    bars[11].low = 1.0;
    const lows = (await findSwingPoints({ window: 5, _deps: depsWithBars(bars) })).swings.filter((s) => s.type === 'swing_low');
    assert.deepEqual(lows.map((s) => s.bar_index), [10]);
  });

  it('makes no swing from a flat run of equal bars', async () => {
    const bars = makeBars({ count: 21, highIndex: null, lowIndex: null });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    assert.deepEqual(result.swings, []);
    assert.deepEqual(result.provisional, []);
  });

  it('lists a high among the newest bars as provisional, not as a confirmed swing', async () => {
    const bars = makeBars({ count: 21, highIndex: 18, lowIndex: null });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    assert.equal(result.swings.some((s) => s.bar_index === 18), false);
    const p = result.provisional.filter((s) => s.type === 'swing_high');
    assert.equal(p.length, 1);
    assert.equal(p[0].bar_index, 18);
    assert.equal(p[0].price, 1.2);
    assert.equal(p[0].bars_after, 2);
    assert.equal(p[0].bars_needed, 5);
  });

  it('drops a provisional high as soon as a later bar goes above it', async () => {
    const bars = makeBars({ count: 21, highIndex: 18, lowIndex: null });
    bars[20].high = 1.3;
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    const highs = result.provisional.filter((s) => s.type === 'swing_high');
    assert.deepEqual(highs.map((s) => s.bar_index), [20]);
  });

  it('confirms the same high once five bars have printed after it', async () => {
    const bars = makeBars({ count: 24, highIndex: 18, lowIndex: null });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    assert.ok(result.swings.some((s) => s.bar_index === 18));
    assert.equal(result.provisional.some((s) => s.bar_index === 18), false);
  });

  it('does not flag the swing-high bar as a swing low (or vice versa) when its other side is at baseline', async () => {
    const bars = makeBars({ count: 21, highIndex: 10, lowIndex: 15 });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    assert.ok(!result.swings.some((s) => s.bar_index === 10 && s.type === 'swing_low'));
    assert.ok(!result.swings.some((s) => s.bar_index === 15 && s.type === 'swing_high'));
  });

  it('a tie at baseline never counts as a swing (strict inequality)', async () => {
    const bars = makeBars({ count: 21, highIndex: null, lowIndex: null }); // perfectly flat, no spikes
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    assert.equal(result.swings.length, 0);
  });

  it('respects the window size — a spike too close to the edge for a larger window is not found', async () => {
    const bars = makeBars({ count: 21, highIndex: 10, lowIndex: 15 });
    const wide = await findSwingPoints({ window: 9, _deps: depsWithBars(bars) }); // needs bars[1..19], index 10 still fits but 15 does not (15+9=24 > 20)
    const highs = wide.swings.filter((s) => s.type === 'swing_high');
    const lows = wide.swings.filter((s) => s.type === 'swing_low');
    assert.equal(highs.length, 1); // index 10 still has 9 bars on both sides within a 21-bar set
    assert.equal(lows.length, 0); // index 15 does not have 9 bars available after it
  });

  it('reports zero swings with a clear note when there are not enough bars for the window, rather than erroring', async () => {
    const bars = makeBars({ count: 21 });
    const result = await findSwingPoints({ window: 20, _deps: depsWithBars(bars) });
    assert.equal(result.success, true);
    assert.equal(result.swing_count, 0);
    assert.match(result.note, /Not enough bars/);
  });

  it('clamps an absurd window to the max instead of erroring', async () => {
    const bars = makeBars({ count: 21 });
    const result = await findSwingPoints({ window: 99999, _deps: depsWithBars(bars) });
    assert.equal(result.window, 50); // clamped
  });

  it('defaults window to 5 when omitted', async () => {
    const bars = makeBars({ count: 21, highIndex: 10, lowIndex: 15 });
    const result = await findSwingPoints({ _deps: depsWithBars(bars) });
    assert.equal(result.window, 5);
    assert.equal(result.swings.filter((s) => s.type === 'swing_high').length, 1);
  });

  it('throws a clear error when the chart has no bars yet', async () => {
    await assert.rejects(
      () => findSwingPoints({ _deps: { evaluate: async () => null } }),
      /Could not extract OHLCV data/
    );
  });

  it('reports swing time in the same units the bars provided (no unit conversion applied)', async () => {
    const bars = makeBars({ count: 21, highIndex: 10, lowIndex: null });
    const result = await findSwingPoints({ window: 5, _deps: depsWithBars(bars) });
    const high = result.swings.find((s) => s.type === 'swing_high');
    assert.equal(high.time, bars[10].time);
  });
});
