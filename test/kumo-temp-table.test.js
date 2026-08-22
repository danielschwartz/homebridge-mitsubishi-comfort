'use strict';

// The Kumo app renders Fahrenheit from a fixed lookup table rather than by
// arithmetic conversion, so matching it is a table problem, not a rounding one.
// These tests pin both directions of the mapping and the stability of a value
// written from one app and read back in the other.

const test = require('node:test');
const assert = require('node:assert');
const {
  kumoFahrenheit,
  celsiusForHomeKit,
  toHomeKitCelsius,
  toKumoCelsius,
  CELSIUS_TO_KUMO_FAHRENHEIT,
  KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS,
} = require('../dist/kumo-temp-table.js');

const SETPOINTS = Array.from({ length: 20 }, (_, i) => 61 + i); // 61..80°F

/** What the Home app displays for a Celsius characteristic value. */
const homeAppShows = (celsius) => Math.round(celsius * 9 / 5 + 32);

/** What iOS writes over HAP when the user picks a whole °F (verified live: 64°F → 17.8°C). */
const iosSendsFor = (fahrenheit) => Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;

test('the two Kumo tables are mutually consistent', () => {
  for (const f of SETPOINTS) {
    const celsius = KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS[f];
    assert.notStrictEqual(celsius, undefined, `no Celsius mapping for ${f}°F`);
    assert.strictEqual(
      CELSIUS_TO_KUMO_FAHRENHEIT[String(celsius)], f,
      `${f}°F stores ${celsius}°C, which displays as something else`,
    );
  }
});

test('a temperature set in the Home app displays the same number in Kumo', () => {
  for (const f of SETPOINTS) {
    const sentToKumo = toKumoCelsius(iosSendsFor(f));
    assert.strictEqual(kumoFahrenheit(sentToKumo), f, `Home app ${f}°F showed as ${kumoFahrenheit(sentToKumo)}°F in Kumo`);
  }
});

test('a temperature set in Kumo displays the same number in the Home app', () => {
  for (const f of SETPOINTS) {
    const reported = toHomeKitCelsius(KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS[f]);
    assert.strictEqual(homeAppShows(reported), f, `Kumo ${f}°F showed as ${homeAppShows(reported)}°F in the Home app`);
  }
});

test('the seven values that arithmetic conversion gets wrong', () => {
  // Where Kumo's table and true conversion disagree by a full degree.
  const divergent = { 18: 65, 18.5: 66, 19: 67, 20.5: 68, 21: 69, 21.5: 70, 22: 71 };
  for (const [celsius, expected] of Object.entries(divergent)) {
    const c = Number(celsius);
    assert.strictEqual(kumoFahrenheit(c), expected, `Kumo shows ${expected}°F for ${c}°C`);
    assert.notStrictEqual(Math.round(c * 9 / 5 + 32), expected, `${c}°C would not be a divergence`);
  }
});

test('writing then reading back does not drift', () => {
  for (const f of SETPOINTS) {
    const fromHomeKit = iosSendsFor(f);
    const stored = toKumoCelsius(fromHomeKit);
    const readBack = toHomeKitCelsius(stored);
    assert.strictEqual(readBack, fromHomeKit, `${f}°F drifted ${fromHomeKit} -> ${readBack}`);
    assert.strictEqual(toKumoCelsius(readBack), stored, `${f}°F re-write drifted ${stored} -> ${toKumoCelsius(readBack)}`);
  }
});

test('an exact whole-degree Fahrenheit Celsius bypasses the table', () => {
  // 20°C is exactly 68°F, so Kumo uses arithmetic rather than the lookup.
  assert.strictEqual(kumoFahrenheit(20), 68);
  assert.strictEqual(kumoFahrenheit(25), 77);
});

test('Celsius reported to HomeKit round-trips through the Home app', () => {
  for (let f = 20; f <= 120; f++) {
    assert.strictEqual(homeAppShows(celsiusForHomeKit(f)), f, `${f}°F did not round-trip`);
  }
});

test('values outside the table fall back to arithmetic', () => {
  assert.strictEqual(kumoFahrenheit(-40), -40);
  assert.strictEqual(toKumoCelsius(40), 40); // 104°F has no table entry
});

test('an exact whole-degree Celsius overrides a disagreeing table entry', () => {
  // 30°C is exactly 86°F, so arithmetic wins even though the table says 87.
  assert.strictEqual(CELSIUS_TO_KUMO_FAHRENHEIT['30'], 87);
  assert.strictEqual(kumoFahrenheit(30), 86);
});

test('the table is not injective', () => {
  assert.strictEqual(kumoFahrenheit(19), kumoFahrenheit(19.5));
  assert.strictEqual(kumoFahrenheit(20.5), 68);
});
