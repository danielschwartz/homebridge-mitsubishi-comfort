'use strict';

// Round-trip and HAP-conformance tests for the fan-speed and vane-direction
// percentage mappings. These two sliders coerce through HAP characteristics with
// different formats, and each format constrains the mapping differently:
//
//  - RotationSpeed is a HAP *float*, but 0 is reserved: HomeKit reads
//    RotationSpeed 0 as "fan off" and the Home app pairs the bottom of the
//    slider with Active=INACTIVE. Speeds must therefore live in (0, 100].
//  - Current/TargetPosition are HAP *uint8*, and hap-nodejs snaps a written
//    value to `minStep * Math.round(value / minStep)` without re-rounding to an
//    integer. The step and every emitted percentage must be whole numbers.

const test = require('node:test');
const assert = require('node:assert');

const { KumoThermostatAccessory } = require('../dist/accessory.js');

// The statics under test are private to TypeScript but plain statics at runtime.
const fanStepFor = KumoThermostatAccessory.fanStepFor;
const fanIndexToPercent = KumoThermostatAccessory.fanIndexToPercent;
const fanPercentToIndex = KumoThermostatAccessory.fanPercentToIndex;
const vaneStepFor = KumoThermostatAccessory.vaneStepFor;
const vaneIndexToPercent = KumoThermostatAccessory.vaneIndexToPercent;
const vanePercentToIndex = KumoThermostatAccessory.vanePercentToIndex;

/** hap-nodejs Characteristic.js value coercion, for the formats we rely on. */
function hapCoerce(value, minStep, format) {
  const step = format === 'float' ? minStep : Math.max(minStep, 1);
  let v = step * Math.round(value / step);
  // Note: hap-nodejs does NOT re-round to an integer for integer formats — that
  // is precisely why vaneStepFor must keep the step whole.
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}

// A unit reports 1..5 fan speeds and may or may not offer `auto`, so the label
// list is 1..6 entries long.
const FAN_COUNTS = [1, 2, 3, 4, 5, 6];
// Six fixed vane positions, plus `swing` on units that can swing.
const VANE_COUNTS = [6, 7];

test('fan: no speed maps to 0% (0 is reserved for "off")', () => {
  for (const count of FAN_COUNTS) {
    for (let i = 0; i < count; i++) {
      const pct = fanIndexToPercent(i, count);
      assert.ok(pct > 0, `count=${count} idx=${i} produced ${pct}%, which HomeKit reads as off`);
      assert.ok(pct <= 100, `count=${count} idx=${i} produced ${pct}% > 100`);
    }
  }
});

test('fan: index -> percent -> index round-trips through HAP float coercion', () => {
  for (const count of FAN_COUNTS) {
    const step = fanStepFor(count);
    for (let i = 0; i < count; i++) {
      const stored = hapCoerce(fanIndexToPercent(i, count), step, 'float');
      assert.strictEqual(
        fanPercentToIndex(stored, count), i,
        `count=${count} idx=${i} stored=${stored} did not round-trip`,
      );
    }
  }
});

test('fan: top of the slider is always the fastest speed', () => {
  for (const count of FAN_COUNTS) {
    assert.strictEqual(fanIndexToPercent(count - 1, count), 100);
    assert.strictEqual(fanPercentToIndex(100, count), count - 1);
  }
});

test('fan: arbitrary off-grid percentages clamp into range', () => {
  for (const count of FAN_COUNTS) {
    for (const pct of [0, 1, 7, 33, 49, 50, 51, 99, 100]) {
      const idx = fanPercentToIndex(pct, count);
      assert.ok(
        Number.isInteger(idx) && idx >= 0 && idx < count,
        `count=${count} pct=${pct} produced out-of-range index ${idx}`,
      );
    }
  }
});

test('vane: step and every percentage are integers (uint8 characteristics)', () => {
  for (const count of VANE_COUNTS) {
    const step = vaneStepFor(count);
    assert.ok(Number.isInteger(step), `count=${count} step ${step} is not an integer`);
    for (let i = 0; i < count; i++) {
      const pct = vaneIndexToPercent(i, count);
      assert.ok(
        Number.isInteger(pct),
        `count=${count} idx=${i} produced non-integer ${pct} for a uint8 characteristic`,
      );
    }
  }
});

test('vane: index -> percent -> index round-trips through HAP uint8 coercion', () => {
  for (const count of VANE_COUNTS) {
    const step = vaneStepFor(count);
    for (let i = 0; i < count; i++) {
      const stored = hapCoerce(vaneIndexToPercent(i, count), step, 'uint8');
      assert.strictEqual(
        vanePercentToIndex(stored, count), i,
        `count=${count} idx=${i} stored=${stored} did not round-trip`,
      );
    }
  }
});

test('vane: Target and Current agree after coercion (no phantom "moving" state)', () => {
  // HomeKit renders a covering as in-motion whenever Current !== Target, so the
  // value we push to both must survive coercion identically.
  for (const count of VANE_COUNTS) {
    const step = vaneStepFor(count);
    for (let i = 0; i < count; i++) {
      const pct = vaneIndexToPercent(i, count);
      assert.strictEqual(
        hapCoerce(pct, step, 'uint8'), hapCoerce(pct, step, 'uint8'),
        `count=${count} idx=${i} coerced inconsistently`,
      );
      assert.strictEqual(
        hapCoerce(pct, step, 'uint8'), pct,
        `count=${count} idx=${i}: ${pct} is not on the minStep grid (coerced to ` +
        `${hapCoerce(pct, step, 'uint8')}), so Current and Target would disagree`,
      );
    }
  }
});

test('vane: swing is only reachable when the unit has it', () => {
  // 6 positions = no swing; the last position must not be swing's slot.
  assert.strictEqual(vanePercentToIndex(100, 6), 5);
  assert.strictEqual(vanePercentToIndex(100, 7), 6);
});
