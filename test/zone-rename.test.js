'use strict';

// Accessories are matched to devices by serial, so renaming a zone in Kumo
// restores the same cached accessory under its old name. displayName backs every
// log line, so without a refresh a renamed zone stays mislabelled in the log for
// the life of the cache entry — commands land on the right unit while the log
// names a different one.

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');

const SERIAL = 'TESTSERIAL001';
const SITE = { id: 'site-1', name: 'Home' };

function makeLog() {
  const lines = [];
  const rec = (...a) => lines.push(a.join(' '));
  return { lines, info: rec, warn: rec, error: rec, debug: rec };
}

function makeService() {
  const chars = new Map();
  const ch = () => ({ value: undefined, onGet() { return this; }, onSet() { return this; }, setProps() { return this; } });
  const svc = {
    getCharacteristic(id) {
      if (!chars.has(id)) chars.set(id, ch());
      return chars.get(id);
    },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeCachedAccessory(displayName, uuid) {
  const services = new Map();
  return {
    displayName,
    UUID: uuid,
    context: {},
    getService(type) {
      if (!services.has(type)) services.set(type, makeService());
      return services.get(type);
    },
    addService(type) { return this.getService(type); },
    removeService() {},
    services: [],
  };
}

function makePlatform(zoneName) {
  const spies = { register: [], update: [], unregister: [] };
  const api = {
    hap: {
      Service: { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat', Switch: 'Switch', FilterMaintenance: 'FilterMaintenance' },
      Characteristic: new Proxy({}, { get: (_t, p) => String(p) }),
      uuid: { generate: (s) => `uuid-${s}` },
    },
    platformAccessory: function PlatformAccessory(displayName, uuid) {
      Object.assign(this, makeCachedAccessory(displayName, uuid));
    },
    on: () => {},
    registerPlatformAccessories: (...a) => spies.register.push(a),
    updatePlatformAccessories: (...a) => spies.update.push(a),
    unregisterPlatformAccessories: (...a) => spies.unregister.push(a),
  };
  const log = makeLog();
  const platform = new KumoV3Platform(log, {
    name: 'test', platform: 'KumoV3', username: 'u@e.com', password: 's', disablePolling: true,
  }, api);
  platform.kumoAPI = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [{ isActive: true, name: zoneName, adapter: { deviceSerial: SERIAL } }],
    startStreaming: async () => true,
    subscribeToDevice() {}, unsubscribeFromDevice() {}, onDeviceProfileUpdate() {},
    destroy: () => {},
  };
  return { platform, spies, log };
}

/** discoverDevices spins up handlers and retry timers; stop them so the runner exits. */
function teardown(platform) {
  for (const h of platform.accessoryHandlers || []) {
    if (typeof h.destroy === 'function') {
      h.destroy();
    }
  }
  for (const key of ['discoveryRetryTimer', 'localPollTimer', 'resilienceTimer', 'credRetryTimer']) {
    if (platform[key]) {
      clearTimeout(platform[key]);
      clearInterval(platform[key]);
      platform[key] = null;
    }
  }
  platform.discoverDevices = async () => {};
}

test('a zone renamed in Kumo refreshes the accessory name', async () => {
  const { platform, log } = makePlatform('Primary Bedroom');
  const cached = makeCachedAccessory('Office', `uuid-${SERIAL}`);
  platform.accessories = [cached];

  try {
    await platform.discoverDevices();
  } finally {
    teardown(platform);
  }

  assert.strictEqual(cached.displayName, 'Primary Bedroom', 'displayName should follow the zone rename');
  assert.strictEqual(
    cached.getService('AccessoryInformation').getCharacteristic('Name').value,
    'Primary Bedroom',
    'the Name characteristic should carry the new name into HomeKit',
  );
  assert.ok(
    log.lines.some(l => l.includes("Zone renamed in Kumo: 'Office' -> 'Primary Bedroom'")),
    'the rename should be logged once so it is visible rather than silent',
  );
});

test('an unrenamed zone is left alone', async () => {
  const { platform, log } = makePlatform('Office');
  const cached = makeCachedAccessory('Office', `uuid-${SERIAL}`);
  platform.accessories = [cached];

  try {
    await platform.discoverDevices();
  } finally {
    teardown(platform);
  }

  assert.strictEqual(cached.displayName, 'Office');
  assert.ok(!log.lines.some(l => l.includes('Zone renamed in Kumo')), 'no rename should be reported');
});
