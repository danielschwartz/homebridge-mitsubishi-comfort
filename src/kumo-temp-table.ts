/**
 * Mitsubishi's own Celsius/Fahrenheit conversion tables, as used by the Kumo
 * Comfort app.
 *
 * The Kumo API carries temperatures in Celsius, but the Kumo app does not render
 * Fahrenheit arithmetically. It snaps the Celsius value to the nearest half degree
 * and reads a fixed lookup table, falling back to arithmetic only when the Celsius
 * value converts to an exact whole Fahrenheit degree. Across the 65-72F comfort
 * band that table differs from true conversion by a full degree at seven points,
 * so any arithmetic conversion disagrees with what the user sees in Kumo.
 *
 * Both tables are transcribed from the Kumo Cloud web client bundle
 * (app.kumocloud.com/js/kumocloud.cmp.js), where they back the `tempPresenter`
 * service's convertFromTableIfWithinRange() and convertToC().
 */

/** Half-degree Celsius to the whole Fahrenheit degree Kumo displays for it. */
export const CELSIUS_TO_KUMO_FAHRENHEIT: Readonly<Record<string, number>> = {
  '10': 50,
  '10.5': 51,
  '11': 52,
  '11.5': 53,
  '12': 53,
  '12.5': 54,
  '13': 55,
  '13.5': 56,
  '14': 57,
  '14.5': 58,
  '15': 59,
  '15.5': 60,
  '16': 61,
  '16.5': 62,
  '17': 63,
  '17.5': 64,
  '18': 65,
  '18.5': 66,
  '19': 67,
  '19.5': 67,
  '20': 68,
  '20.5': 68,
  '21': 69,
  '21.5': 70,
  '22': 71,
  '22.5': 72,
  '23': 73,
  '23.5': 74,
  '24': 75,
  '24.5': 76,
  '25': 77,
  '25.5': 78,
  '26': 79,
  '26.5': 80,
  '27': 81,
  '27.5': 82,
  '28': 83,
  '28.5': 84,
  '29': 85,
  '29.5': 86,
  '30': 87,
  '30.5': 88,
  '31': 88,
  '31.5': 89,
  '32': 89,
  '32.5': 90,
  '33': 91,
};

/**
 * Whole Fahrenheit degree to the Celsius value Kumo stores for a `set_temp` write.
 *
 * This is the `convertToC` table, and it governs only the MELSHI adapter family,
 * which carries a single `set_temp`. Units exposing the `spHeat`/`spCool` pair —
 * the ones this plugin drives — take the arithmetic path instead, so this table
 * is reference data rather than part of the write path. See toKumoCelsius.
 */
export const KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS: Readonly<Record<number, number>> = {
  55: 13,
  56: 13.5,
  57: 14,
  58: 14.5,
  59: 15,
  60: 15.5,
  61: 16,
  62: 16.5,
  63: 17,
  64: 17.5,
  65: 18,
  66: 18.5,
  67: 19.5,
  68: 20,
  69: 21,
  70: 21.5,
  71: 22,
  72: 22.5,
  73: 23,
  74: 23.5,
  75: 24,
  76: 24.5,
  77: 25,
  78: 25.5,
  79: 26,
  80: 26.5,
  81: 27,
  82: 27.5,
  83: 28,
  84: 28.5,
  85: 29,
  86: 29.5,
  87: 30,
  88: 31,
  89: 31.5,
  90: 32.5,
};

/** Tolerance within which a Celsius value counts as an exact whole Fahrenheit degree. */
const EXACT_FAHRENHEIT_EPSILON = 0.001;

function roundToHalfDegree(celsius: number): number {
  return Math.round(celsius * 2) / 2;
}

/**
 * The whole Fahrenheit degree the Kumo app displays for a Celsius value.
 *
 * Mirrors tempPresenter.convertFromTableIfWithinRange(): arithmetic when the
 * Celsius value lands on an exact Fahrenheit degree, table lookup otherwise.
 */
export function kumoFahrenheit(celsius: number): number {
  const exact = celsius * 9 / 5 + 32;
  const nearest = Math.round(exact);
  if (Math.abs(exact - nearest) < EXACT_FAHRENHEIT_EPSILON) {
    return nearest;
  }
  const mapped = CELSIUS_TO_KUMO_FAHRENHEIT[String(roundToHalfDegree(celsius))];
  return mapped === undefined ? nearest : mapped;
}

/**
 * A Celsius value the Home app renders as the given whole Fahrenheit degree.
 *
 * HomeKit is Celsius-native and the Home app converts for display, so the
 * plugin picks the point on the 0.1°C characteristic grid nearest the true
 * conversion. No value in the operating range lands on a .5 rounding tie, so
 * the Home app's rounding mode does not affect the result.
 */
export function celsiusForHomeKit(fahrenheit: number): number {
  return Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;
}

/** Celsius to report to HomeKit so the Home app shows the degree Kumo shows. */
export function toHomeKitCelsius(celsius: number): number {
  return celsiusForHomeKit(kumoFahrenheit(celsius));
}

/**
 * Celsius to send to Kumo so the Kumo app shows the degree picked in HomeKit.
 *
 * Mirrors how the Kumo app writes spHeat/spCool: it renders the setpoint to a
 * whole Fahrenheit degree, then converts straight back with (F - 32) / 1.8. The
 * result sits on an exact Fahrenheit degree, so when Kumo reads it back the
 * arithmetic branch of kumoFahrenheit() fires and the lookup table never applies.
 * That makes the mapping exact at every degree instead of only where the table
 * has an entry.
 */
export function toKumoCelsius(homeKitCelsius: number): number {
  const fahrenheit = Math.round(homeKitCelsius * 9 / 5 + 32);
  return Math.round(((fahrenheit - 32) * 5 / 9) * 10000) / 10000;
}
