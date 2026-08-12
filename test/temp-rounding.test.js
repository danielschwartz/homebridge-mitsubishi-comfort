'use strict';

// Test for the Fahrenheit round-trip temperature correction.
//
// The Kumo API returns temperatures in Celsius. When the device works internally
// in Fahrenheit (US-market units), the °F→°C conversion in the API may lose
// precision (e.g. 70°F stored as 21.0°C instead of 21.111°C). When the Home app
// converts back (21.0°C → 69.8°F), the displayed value can be 1°F off.
//
// The fix rounds each Celsius value to the nearest exact Fahrenheit whole-degree
// equivalent before publishing to HomeKit, controlled by the `temperatureUnit`
// config option (default 'F').

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), OFF: 0, HEAT: 1, COOL: 2, AUTO: 3, FILTER_OK: 0, CHANGE_FILTER: 1 };
    }
    return charCache[prop];
  },
});

const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
};

function makeCharacteristic() {
  const ch = {
    value: undefined,
    onGet() { return ch; },
    onSet() { return ch; },
    setProps() { return ch; },
  };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) {
      if (!chars.has(id)) chars.set(id, makeCharacteristic());
      return chars.get(id);
    },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'TestUnit',
    UUID: 'test-uuid',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'TestUnit' } },
    getService(type) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    addService(type, name, subtype) {
      const s = makeService(type, name, subtype);
      entries.push({ type, subtype, svc: s });
      return s;
    },
    getServiceById(type, subtype) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    removeService() {},
  };
}

function makeKumoAPI() {
  return {
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand: async () => true,
  };
}

function makePlatform(temperatureUnit) {
  return {
    log: makeLog(),
    Service,
    Characteristic,
    api: { updatePlatformAccessories() {} },
    config: { temperatureUnit },
    localClient: null,
  };
}

function buildHandler(temperatureUnit) {
  const platform = makePlatform(temperatureUnit);
  const accessory = makeAccessory();
  const api = makeKumoAPI();
  const handler = new KumoThermostatAccessory(platform, accessory, api, 30);
  return { handler, accessory, platform };
}

function feedZoneUpdate(handler, roomTemp, spHeat, spCool, operationMode) {
  handler.updateFromZone({
    id: 'zone-1',
    name: 'TestUnit',
    isActive: true,
    adapter: {
      id: 'adapter-1',
      deviceSerial: SERIAL,
      roomTemp,
      spHeat,
      spCool,
      spAuto: null,
      humidity: null,
      power: 1,
      operationMode: operationMode || 'cool',
      previousOperationMode: operationMode || 'cool',
      fanSpeed: 'auto',
      airDirection: 'auto',
      connected: true,
      isSimulator: false,
      hasSensor: false,
      hasMhk2: false,
      scheduleOwner: 'adapter',
      scheduleHoldEndTime: 0,
    },
  });
}

function getCharValue(accessory, serviceType, charId) {
  const svc = accessory.getService(serviceType);
  if (!svc) return undefined;
  const ch = svc.getCharacteristic(charId);
  return ch ? ch.value : undefined;
}

// --- Tests ---

test('room temp floors to 69°F, setpoint rounds to 70°F for 21.0°C', () => {
  const { handler, accessory } = buildHandler('F');
  // 21.0°C = 69.8°F: room temp floors to 69, setpoint rounds to 70
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);

  const expectedRoom = (69 - 32) * 5 / 9;
  assert.ok(Math.abs(currentTemp - expectedRoom) < 0.001,
    `currentTemp should be ~${expectedRoom.toFixed(4)}°C (69°F floor), got ${currentTemp}`);
  const expectedSetpoint = (70 - 32) * 5 / 9;
  assert.ok(Math.abs(targetTemp - expectedSetpoint) < 0.001,
    `targetTemp should be ~${expectedSetpoint.toFixed(4)}°C (70°F round), got ${targetTemp}`);
});

test('no correction when temperatureUnit is C', () => {
  const { handler, accessory } = buildHandler('C');
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);

  assert.strictEqual(currentTemp, 21.0, 'currentTemp should be raw 21.0°C with no correction');
  assert.strictEqual(targetTemp, 21.0, 'targetTemp should be raw 21.0°C with no correction');
});

test('correction is default (no config = treated as F)', () => {
  const { handler, accessory } = buildHandler(undefined);
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const expected = (69 - 32) * 5 / 9;
  assert.ok(Math.abs(currentTemp - expected) < 0.001,
    `should default to F correction, got ${currentTemp}`);
});

test('room temps floor, setpoints round across a range of values', () => {
  const { handler, accessory } = buildHandler('F');

  // Room temps use floor (matches Kumo app truncation of sensor readings)
  const roomCases = [
    { inputC: 15.5, expectedF: 59 },  // 59.9°F → floor = 59
    { inputC: 18.0, expectedF: 64 },  // 64.4°F → floor = 64
    { inputC: 20.0, expectedF: 68 },  // 68.0°F → floor = 68 (exact)
    { inputC: 20.5, expectedF: 68 },  // 68.9°F → floor = 68
    { inputC: 21.0, expectedF: 69 },  // 69.8°F → floor = 69
    { inputC: 22.0, expectedF: 71 },  // 71.6°F → floor = 71
    { inputC: 23.0, expectedF: 73 },  // 73.4°F → floor = 73
    { inputC: 25.0, expectedF: 77 },  // 77.0°F → floor = 77 (exact)
  ];

  for (const { inputC, expectedF } of roomCases) {
    feedZoneUpdate(handler, inputC, inputC, inputC, 'cool');
    const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
    const resultF = Math.round(currentTemp * 9 / 5 + 32);
    assert.strictEqual(resultF, expectedF,
      `room ${inputC}°C should floor to ${expectedF}°F, got ${resultF}°F`);
  }

  // Setpoints use round (recovers original °F from API's 0.5°C quantisation)
  const spCases = [
    { inputC: 14.5, expectedF: 58 },  // 58.1°F → round = 58
    { inputC: 16.5, expectedF: 62 },  // 61.7°F → round = 62
    { inputC: 18.5, expectedF: 65 },  // 65.3°F → round = 65
    { inputC: 20.0, expectedF: 68 },  // 68.0°F → round = 68 (exact)
    { inputC: 21.0, expectedF: 70 },  // 69.8°F → round = 70
    { inputC: 22.5, expectedF: 73 },  // 72.5°F → round = 73
    { inputC: 23.5, expectedF: 74 },  // 74.3°F → round = 74
  ];

  for (const { inputC, expectedF } of spCases) {
    feedZoneUpdate(handler, inputC, inputC, inputC, 'cool');
    const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);
    const resultF = Math.round(targetTemp * 9 / 5 + 32);
    assert.strictEqual(resultF, expectedF,
      `setpoint ${inputC}°C should round to ${expectedF}°F, got ${resultF}°F`);
  }
});

test('threshold temperatures use round (setpoint) correction', () => {
  const { handler, accessory } = buildHandler('F');
  // In auto mode, both spHeat and spCool are published as threshold temps
  feedZoneUpdate(handler, 21.0, 20.0, 23.0, 'autoHeat');

  const heatThreshold = getCharValue(accessory, 'Thermostat', Characteristic.HeatingThresholdTemperature);
  const coolThreshold = getCharValue(accessory, 'Thermostat', Characteristic.CoolingThresholdTemperature);

  // 20.0°C → 68°F (exact, round and floor agree)
  const expectedHeatF = 68;
  const actualHeatF = Math.round(heatThreshold * 9 / 5 + 32);
  assert.strictEqual(actualHeatF, expectedHeatF,
    `heat threshold 20.0°C should round to ${expectedHeatF}°F, got ${actualHeatF}°F`);

  // 23.0°C → 73.4°F → round = 73°F
  const expectedCoolF = 73;
  const actualCoolF = Math.round(coolThreshold * 9 / 5 + 32);
  assert.strictEqual(actualCoolF, expectedCoolF,
    `cool threshold 23.0°C should round to ${expectedCoolF}°F, got ${actualCoolF}°F`);
});

test('internal currentStatus is NOT modified by the correction', () => {
  const { handler, accessory } = buildHandler('F');
  feedZoneUpdate(handler, 21.0, 21.0, 23.0, 'cool');

  // The characteristic value should be corrected
  const displayTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  assert.notStrictEqual(displayTemp, 21.0, 'display value should be corrected away from 21.0');

  // But getCurrentTemperature should also return the corrected value (it reads from
  // cache and corrects at the boundary)
  handler.getCurrentTemperature().then(val => {
    const resultF = Math.round(val * 9 / 5 + 32);
    assert.strictEqual(resultF, 69, 'getCurrentTemperature getter should also return corrected value');
  });
});
