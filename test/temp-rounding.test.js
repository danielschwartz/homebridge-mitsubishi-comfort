'use strict';

// The Kumo app renders Fahrenheit from a fixed lookup table rather than by
// arithmetic conversion, so the plugin publishes to HomeKit the Celsius value
// whose Home-app rendering matches the degree Kumo displays. Controlled by the
// `temperatureUnit` config option (default 'F').

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
  const sent = [];
  return {
    sent,
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand: async (_serial, commands) => {
      sent.push(commands);
      return true;
    },
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
  return { handler, accessory, platform, api };
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

test('21.0°C renders as 69°F for both room temp and setpoint', () => {
  const { handler, accessory } = buildHandler('F');
  // Kumo's table maps 21.0°C to 69°F, where arithmetic would give 69.8 → 70°F.
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);

  assert.strictEqual(currentTemp, 20.6, `currentTemp should be 20.6°C (69°F), got ${currentTemp}`);
  assert.strictEqual(targetTemp, 20.6, `targetTemp should be 20.6°C (69°F), got ${targetTemp}`);
  assert.strictEqual(Math.round(currentTemp * 9 / 5 + 32), 69);
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
  // 21°C is 69°F in Kumo's table; the reported Celsius sits on the 0.1°C
  // characteristic grid and renders back to 69°F in the Home app.
  assert.strictEqual(currentTemp, 20.6, `should default to F correction (21°C → 69°F), got ${currentTemp}`);
  assert.strictEqual(Math.round(currentTemp * 9 / 5 + 32), 69);
});

test('every half-degree Celsius renders the same °F the Kumo app shows', () => {
  const { handler, accessory } = buildHandler('F');

  // Every 0.5°C step in the operating range, with the °F the Kumo app displays.
  // Kumo reads these from a lookup table except where the Celsius lands on an
  // exact Fahrenheit degree, which is why several entries differ from arithmetic.
  const cases = [
    { inputC: 14.0, expectedF: 57 },
    { inputC: 14.5, expectedF: 58 },
    { inputC: 15.0, expectedF: 59 },  // 59.0°F exactly — arithmetic, not the table
    { inputC: 15.5, expectedF: 60 },
    { inputC: 16.0, expectedF: 61 },
    { inputC: 16.5, expectedF: 62 },
    { inputC: 17.0, expectedF: 63 },
    { inputC: 17.5, expectedF: 64 },
    { inputC: 18.0, expectedF: 65 },  // table; arithmetic would say 64
    { inputC: 18.5, expectedF: 66 },  // table; arithmetic would say 65
    { inputC: 19.0, expectedF: 67 },  // table; arithmetic would say 66
    { inputC: 19.5, expectedF: 67 },  // collides with 19.0
    { inputC: 20.0, expectedF: 68 },  // 68.0°F exactly — arithmetic
    { inputC: 20.5, expectedF: 68 },  // table; arithmetic would say 69
    { inputC: 21.0, expectedF: 69 },  // table; arithmetic would say 70
    { inputC: 21.5, expectedF: 70 },  // table; arithmetic would say 71
    { inputC: 22.0, expectedF: 71 },  // table; arithmetic would say 72
    { inputC: 22.5, expectedF: 72 },
    { inputC: 23.0, expectedF: 73 },
    { inputC: 23.5, expectedF: 74 },
    { inputC: 24.0, expectedF: 75 },
    { inputC: 24.5, expectedF: 76 },
    { inputC: 25.0, expectedF: 77 },  // 77.0°F exactly — arithmetic
  ];

  for (const { inputC, expectedF } of cases) {
    feedZoneUpdate(handler, inputC, inputC, inputC, 'cool');

    const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
    const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);
    const currentF = Math.round(currentTemp * 9 / 5 + 32);
    const targetF = Math.round(targetTemp * 9 / 5 + 32);
    assert.strictEqual(currentF, expectedF,
      `room temp ${inputC}°C should be ${expectedF}°F, got ${currentF}°F`);
    assert.strictEqual(targetF, expectedF,
      `setpoint ${inputC}°C should be ${expectedF}°F, got ${targetF}°F`);
  }
});

test('threshold temperatures use the same table conversion', () => {
  const { handler, accessory } = buildHandler('F');
  feedZoneUpdate(handler, 21.0, 20.0, 23.0, 'autoHeat');

  const heatThreshold = getCharValue(accessory, 'Thermostat', Characteristic.HeatingThresholdTemperature);
  const coolThreshold = getCharValue(accessory, 'Thermostat', Characteristic.CoolingThresholdTemperature);

  const actualHeatF = Math.round(heatThreshold * 9 / 5 + 32);
  assert.strictEqual(actualHeatF, 68,
    `heat threshold 20.0°C should be 68°F, got ${actualHeatF}°F`);

  const actualCoolF = Math.round(coolThreshold * 9 / 5 + 32);
  assert.strictEqual(actualCoolF, 73,
    `cool threshold 23.0°C should be 73°F, got ${actualCoolF}°F`);
});

test('internal currentStatus is NOT modified by the correction', async () => {
  const { handler, accessory } = buildHandler('F');
  feedZoneUpdate(handler, 21.0, 21.0, 23.0, 'cool');

  // The characteristic value should be corrected
  const displayTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  assert.notStrictEqual(displayTemp, 21.0, 'display value should be corrected away from 21.0');

  // But getCurrentTemperature should also return the corrected value (it reads from
  // cache and corrects at the boundary)
  const val = await handler.getCurrentTemperature();
  assert.strictEqual(Math.round(val * 9 / 5 + 32), 69,
    'getCurrentTemperature getter should also return the corrected value');
});


// The write path is what reaches the device, and every other suite pins
// temperatureUnit to 'C' — where the mapping is deliberately a no-op. These
// exercise it under the shipping default.

test('a setpoint written from HomeKit reaches Kumo on an exact °F degree', async () => {
  for (const fahrenheit of [61, 64, 65, 66, 69, 70, 71, 72, 80]) {
    const { handler, api } = buildHandler('F');
    feedZoneUpdate(handler, 22.0, 22.0, 22.0, 'cool');
    api.sent.length = 0;

    // What iOS sends over HAP for this degree.
    const fromHomeKit = Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;
    await handler.setTargetTemperature(fromHomeKit);

    assert.strictEqual(api.sent.length, 1, `${fahrenheit}°F sent ${api.sent.length} commands`);
    const sentC = api.sent[0].spCool;
    assert.strictEqual(Math.round(sentC * 9 / 5 + 32), fahrenheit,
      `${fahrenheit}°F was sent to Kumo as ${sentC}°C`);
    // Landing on an exact °F is what makes Kumo bypass its lookup table.
    assert.ok(Math.abs((sentC * 9 / 5 + 32) - fahrenheit) < 0.001,
      `${sentC}°C is not an exact ${fahrenheit}°F`);
  }
});

test('a Celsius user\'s setpoint is passed through untouched', async () => {
  const { handler, api } = buildHandler('C');
  feedZoneUpdate(handler, 22.0, 22.0, 22.0, 'cool');
  api.sent.length = 0;

  await handler.setTargetTemperature(18.3);
  assert.strictEqual(api.sent[0].spCool, 18.3, 'Celsius users must see no remapping');
});

test('the AUTO band handles are mapped on the way out too', async () => {
  const { handler, api } = buildHandler('F');
  feedZoneUpdate(handler, 22.0, 20.0, 24.0, 'autoHeat');
  api.sent.length = 0;

  await handler.setCoolingThresholdTemperature(Math.round(((75 - 32) * 5 / 9) * 10) / 10);
  const sentC = api.sent[0].spCool;
  assert.strictEqual(Math.round(sentC * 9 / 5 + 32), 75, `cool handle sent ${sentC}°C`);
});
