"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toKumoCelsius = exports.toHomeKitCelsius = exports.celsiusForHomeKit = exports.kumoFahrenheit = exports.KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS = exports.CELSIUS_TO_KUMO_FAHRENHEIT = void 0;
exports.CELSIUS_TO_KUMO_FAHRENHEIT = {
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
exports.KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS = {
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
const EXACT_FAHRENHEIT_EPSILON = 0.001;
function roundToHalfDegree(celsius) {
    return Math.round(celsius * 2) / 2;
}
function kumoFahrenheit(celsius) {
    const exact = celsius * 9 / 5 + 32;
    const nearest = Math.round(exact);
    if (Math.abs(exact - nearest) < EXACT_FAHRENHEIT_EPSILON) {
        return nearest;
    }
    const mapped = exports.CELSIUS_TO_KUMO_FAHRENHEIT[String(roundToHalfDegree(celsius))];
    return mapped === undefined ? nearest : mapped;
}
exports.kumoFahrenheit = kumoFahrenheit;
function celsiusForHomeKit(fahrenheit) {
    return Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;
}
exports.celsiusForHomeKit = celsiusForHomeKit;
function toHomeKitCelsius(celsius) {
    return celsiusForHomeKit(kumoFahrenheit(celsius));
}
exports.toHomeKitCelsius = toHomeKitCelsius;
function toKumoCelsius(homeKitCelsius) {
    const fahrenheit = Math.round(homeKitCelsius * 9 / 5 + 32);
    return Math.round(((fahrenheit - 32) * 5 / 9) * 10000) / 10000;
}
exports.toKumoCelsius = toKumoCelsius;
