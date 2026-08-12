"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KumoThermostatAccessory = void 0;
const settings_1 = require("./settings");
function snapToFahrenheit(celsius) {
    const f = celsius * 9 / 5 + 32;
    return Math.round(((Math.round(f) - 32) * 5 / 9) * 10000) / 10000;
}
function powerModeLabel(s) {
    if (!s) {
        return 'unknown';
    }
    return s.power === 0 ? 'off' : (s.operationMode || 'unknown');
}
class KumoThermostatAccessory {
    constructor(platform, accessory, kumoAPI, pollIntervalSeconds) {
        var _a;
        this.platform = platform;
        this.accessory = accessory;
        this.kumoAPI = kumoAPI;
        this.pollTimer = null;
        this.currentStatus = null;
        this.hasHumiditySensor = false;
        this.lastUpdateTimestamp = 0;
        this.lastUpdateSource = 'none';
        this.lastLocalUpdateTs = 0;
        this.LOCAL_AUTHORITATIVE_MS = 45000;
        this.hasReceivedValidUpdate = false;
        this.deviceProfile = null;
        this.filterMaintenanceService = null;
        this.fanOnlyService = null;
        this.dryService = null;
        this.modelNumberSet = false;
        this.offRequestedAt = 0;
        this.OFF_SUPPRESS_WINDOW_MS = 4000;
        this.lastCommandOrigin = null;
        this.lastCommandLabel = null;
        this.lastCommandAt = 0;
        this.ATTRIBUTION_MS = 60000;
        this.setpointWriteGen = new Map();
        this.SETPOINT_HOLD_MS = 1500;
        this.statusListeners = [];
        this.useFahrenheitCorrection = ((_a = platform.config) === null || _a === void 0 ? void 0 : _a.temperatureUnit) !== 'C';
        this.deviceSerial = this.accessory.context.device.deviceSerial;
        this.siteId = this.accessory.context.device.siteId;
        this.pollIntervalMs = (pollIntervalSeconds || settings_1.POLL_INTERVAL / 1000) * 1000;
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi')
            .setCharacteristic(this.platform.Characteristic.Model, 'Kumo Cloud Heat Pump')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceSerial);
        this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
            this.accessory.addService(this.platform.Service.Thermostat);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.getCurrentHeatingCoolingState.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .onGet(this.getTargetHeatingCoolingState.bind(this))
            .onSet(this.setTargetHeatingCoolingState.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .onGet(this.getTargetTemperature.bind(this))
            .onSet(this.setTargetTemperature.bind(this));
        const wideThresholdProps = { minValue: 10, maxValue: 35, minStep: 0.1 };
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
            .setProps(wideThresholdProps)
            .onGet(this.getHeatingThresholdTemperature.bind(this))
            .onSet(this.setHeatingThresholdTemperature.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
            .setProps(wideThresholdProps)
            .onGet(this.getCoolingThresholdTemperature.bind(this))
            .onSet(this.setCoolingThresholdTemperature.bind(this));
        const cachedFanSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
        if (cachedFanSwitch) {
            this.fanOnlyService = cachedFanSwitch;
            this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
                .onGet(this.getFanOnlyOn.bind(this))
                .onSet(this.setFanOnlyOn.bind(this));
        }
        const cachedDrySwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
        if (cachedDrySwitch) {
            this.dryService = cachedDrySwitch;
            this.dryService.getCharacteristic(this.platform.Characteristic.On)
                .onGet(this.getDryOn.bind(this))
                .onSet(this.setDryOn.bind(this));
        }
        this.kumoAPI.subscribeToDevice(this.deviceSerial, this.handleStreamingUpdate.bind(this));
        this.platform.log.debug(`Registered streaming callback for ${this.deviceSerial}`);
        this.kumoAPI.onDeviceProfileUpdate((serial, profile) => {
            if (serial === this.deviceSerial) {
                this.applyDeviceProfile(profile);
            }
        });
    }
    correctTemp(celsius) {
        return this.useFahrenheitCorrection ? snapToFahrenheit(celsius) : celsius;
    }
    applyDeviceProfile(profile) {
        this.deviceProfile = profile;
        const minTemp = Math.min(profile.minimumSetPoints.cool, profile.minimumSetPoints.heat, profile.minimumSetPoints.auto);
        const maxTemp = Math.max(profile.maximumSetPoints.cool, profile.maximumSetPoints.heat, profile.maximumSetPoints.auto);
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .setProps({
            minValue: minTemp,
            maxValue: maxTemp,
            minStep: 0.1,
        });
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 0.1 });
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 0.1 });
        const minTempF = (minTemp * 9 / 5) + 32;
        const maxTempF = (maxTemp * 9 / 5) + 32;
        this.platform.log.info(`${this.accessory.displayName}: Set temperature range ${minTemp}-${maxTemp}°C (${minTempF}-${maxTempF}°F)`);
        if (profile.hasModeVent) {
            this.setupFanOnlySwitch();
        }
        else {
            this.removeFanOnlySwitch();
        }
        if (profile.hasModeDry) {
            this.setupDrySwitch();
        }
        else {
            this.removeDrySwitch();
        }
    }
    publishStructureChange() {
        this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    setupFanOnlySwitch() {
        if (this.fanOnlyService) {
            return;
        }
        const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
        const displayName = this.accessory.context.device.displayName;
        const switchName = `${displayName} Fan`;
        this.fanOnlyService =
            existing ||
                this.accessory.addService(this.platform.Service.Switch, switchName, 'fan-only');
        this.fanOnlyService.setCharacteristic(this.platform.Characteristic.Name, switchName);
        this.fanOnlyService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);
        this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
            .onGet(this.getFanOnlyOn.bind(this))
            .onSet(this.setFanOnlyOn.bind(this));
        this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, this.isFanOnlyActive(this.currentStatus));
        if (!existing) {
            this.publishStructureChange();
        }
        this.platform.log.debug(`Added Fan-Only switch for ${this.accessory.displayName}`);
    }
    removeFanOnlySwitch() {
        const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
        if (existing) {
            this.accessory.removeService(existing);
            this.publishStructureChange();
            this.platform.log.debug(`Removed Fan-Only switch for ${this.accessory.displayName} (device reports no vent mode support)`);
        }
        this.fanOnlyService = null;
    }
    isFanOnlyActive(status) {
        if (!status) {
            return false;
        }
        return status.power === 1 && status.operationMode === 'vent';
    }
    async getFanOnlyOn() {
        return this.isFanOnlyActive(this.currentStatus);
    }
    async setFanOnlyOn(value) {
        const on = value;
        const operationMode = on ? 'vent' : 'off';
        const power = on ? 1 : 0;
        this.platform.log.info(`[FAN ONLY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`);
        this.noteModeIntent(operationMode);
        const success = await this.sendDeviceCommand({ operationMode, power }, 'homekit:fan-switch');
        if (!success) {
            this.platform.log.error(`[FAN ONLY] ${this.accessory.displayName}: Failed to set fan-only ${on ? 'ON' : 'OFF'}`);
            setTimeout(() => {
                var _a;
                (_a = this.fanOnlyService) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.On, this.isFanOnlyActive(this.currentStatus));
            }, 100);
            return;
        }
        this.platform.log.info(`[FAN ONLY] ${this.accessory.displayName}: Command accepted by API`);
        if (this.currentStatus) {
            this.currentStatus.operationMode = operationMode;
            this.currentStatus.power = on ? 1 : 0;
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.mapToCurrentHeatingCoolingState(this.currentStatus));
            this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.mapToTargetHeatingCoolingState(this.currentStatus));
        }
        if (this.dryService) {
            this.dryService.updateCharacteristic(this.platform.Characteristic.On, false);
        }
        this.notifyStatusListeners();
    }
    setupDrySwitch() {
        if (this.dryService) {
            return;
        }
        const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
        const displayName = this.accessory.context.device.displayName;
        const switchName = `${displayName} Dry`;
        this.dryService =
            existing ||
                this.accessory.addService(this.platform.Service.Switch, switchName, 'dry');
        this.dryService.setCharacteristic(this.platform.Characteristic.Name, switchName);
        this.dryService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);
        this.dryService.getCharacteristic(this.platform.Characteristic.On)
            .onGet(this.getDryOn.bind(this))
            .onSet(this.setDryOn.bind(this));
        this.dryService.updateCharacteristic(this.platform.Characteristic.On, this.isDryActive(this.currentStatus));
        if (!existing) {
            this.publishStructureChange();
        }
        this.platform.log.debug(`Added Dry switch for ${this.accessory.displayName}`);
    }
    removeDrySwitch() {
        const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
        if (existing) {
            this.accessory.removeService(existing);
            this.publishStructureChange();
            this.platform.log.debug(`Removed Dry switch for ${this.accessory.displayName} (device reports no dry mode support)`);
        }
        this.dryService = null;
    }
    isDryActive(status) {
        if (!status) {
            return false;
        }
        return status.power === 1 && status.operationMode === 'dry';
    }
    async getDryOn() {
        return this.isDryActive(this.currentStatus);
    }
    async setDryOn(value) {
        const on = value;
        const operationMode = on ? 'dry' : 'off';
        const power = on ? 1 : 0;
        this.platform.log.info(`[DRY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`);
        this.noteModeIntent(operationMode);
        const success = await this.sendDeviceCommand({ operationMode, power }, 'homekit:dry-switch');
        if (!success) {
            this.platform.log.error(`[DRY] ${this.accessory.displayName}: Failed to set dry ${on ? 'ON' : 'OFF'}`);
            setTimeout(() => {
                var _a;
                (_a = this.dryService) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.On, this.isDryActive(this.currentStatus));
            }, 100);
            return;
        }
        this.platform.log.info(`[DRY] ${this.accessory.displayName}: Command accepted by API`);
        if (this.currentStatus) {
            this.currentStatus.operationMode = operationMode;
            this.currentStatus.power = on ? 1 : 0;
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.mapToCurrentHeatingCoolingState(this.currentStatus));
            this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.mapToTargetHeatingCoolingState(this.currentStatus));
        }
        if (this.fanOnlyService) {
            this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, false);
        }
        this.notifyStatusListeners();
    }
    updateFilterMaintenance(filterDirty) {
        if (!this.filterMaintenanceService) {
            this.filterMaintenanceService =
                this.accessory.getService(this.platform.Service.FilterMaintenance) ||
                    this.accessory.addService(this.platform.Service.FilterMaintenance);
            this.publishStructureChange();
            this.platform.log.debug(`Added FilterMaintenance service for ${this.accessory.displayName}`);
        }
        this.filterMaintenanceService.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, filterDirty
            ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
            : this.platform.Characteristic.FilterChangeIndication.FILTER_OK);
    }
    handleStreamingUpdate(deviceSerial, data) {
        var _a, _b;
        if (data.roomTemp === undefined || data.roomTemp === null) {
            this.platform.log.debug(`Streaming update for ${deviceSerial} missing essential data, skipping`);
            return;
        }
        const updateTimestamp = Date.now();
        this.platform.log.debug(`Streaming update received for ${deviceSerial}: temp=${data.roomTemp}, mode=${data.operationMode}, power=${data.power}`);
        const zoneUpdate = {
            adapter: {
                id: data.id || '',
                deviceSerial: deviceSerial,
                roomTemp: data.roomTemp,
                spHeat: data.spHeat,
                spCool: data.spCool,
                spAuto: data.spAuto || null,
                humidity: (_a = data.humidity) !== null && _a !== void 0 ? _a : null,
                power: data.power,
                operationMode: data.operationMode,
                previousOperationMode: data.operationMode,
                fanSpeed: data.fanSpeed || 'auto',
                airDirection: data.airDirection || 'auto',
                connected: true,
                isSimulator: false,
                hasSensor: data.humidity !== null && data.humidity !== undefined,
                hasMhk2: false,
                scheduleOwner: 'adapter',
                scheduleHoldEndTime: 0,
                rssi: data.rssi,
            },
        };
        this.processZoneUpdate(zoneUpdate, 'streaming', updateTimestamp);
        if (this.currentStatus) {
            this.currentStatus.modelNumber = data.modelNumber;
            this.currentStatus.connected = data.connected;
            const displayConfig = data.displayConfig;
            if (displayConfig) {
                this.currentStatus.filterDirty = displayConfig.filter === true;
                this.currentStatus.defrost = displayConfig.defrost === true;
                this.currentStatus.standby = displayConfig.standby === true;
            }
            if (!this.modelNumberSet && this.currentStatus.modelNumber) {
                this.accessory.getService(this.platform.Service.AccessoryInformation)
                    .setCharacteristic(this.platform.Characteristic.Model, this.currentStatus.modelNumber);
                this.modelNumberSet = true;
                this.platform.log.info(`${this.accessory.displayName}: Model ${this.currentStatus.modelNumber}`);
            }
            this.updateFilterMaintenance((_b = this.currentStatus.filterDirty) !== null && _b !== void 0 ? _b : false);
        }
    }
    onStatusUpdate(listener) {
        this.statusListeners.push(listener);
    }
    notifyStatusListeners() {
        if (!this.currentStatus || this.statusListeners.length === 0) {
            return;
        }
        const snapshot = this.currentStatus;
        for (const listener of this.statusListeners) {
            try {
                listener(snapshot);
            }
            catch (err) {
                this.platform.log.error('Status listener error:', err);
            }
        }
    }
    getSiteId() {
        return this.siteId;
    }
    getDeviceSerial() {
        return this.deviceSerial;
    }
    updateFromZone(zone) {
        const updateTimestamp = Date.now();
        this.processZoneUpdate(zone, 'polling', updateTimestamp);
    }
    updateFromLocal(status) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        if (status.roomTemp === undefined || status.roomTemp === null) {
            return;
        }
        const updateTimestamp = Date.now();
        const zoneUpdate = {
            id: ((_a = this.currentStatus) === null || _a === void 0 ? void 0 : _a.id) || '',
            adapter: {
                id: ((_b = this.currentStatus) === null || _b === void 0 ? void 0 : _b.id) || '',
                deviceSerial: this.deviceSerial,
                roomTemp: status.roomTemp,
                spHeat: status.spHeat,
                spCool: status.spCool,
                spAuto: (_c = status.spAuto) !== null && _c !== void 0 ? _c : null,
                humidity: (_e = (_d = this.currentStatus) === null || _d === void 0 ? void 0 : _d.humidity) !== null && _e !== void 0 ? _e : null,
                power: status.power,
                operationMode: status.operationMode,
                previousOperationMode: status.operationMode,
                fanSpeed: status.fanSpeed || 'auto',
                airDirection: status.airDirection || 'auto',
                connected: true,
                isSimulator: false,
                hasSensor: ((_f = this.currentStatus) === null || _f === void 0 ? void 0 : _f.humidity) !== null && ((_g = this.currentStatus) === null || _g === void 0 ? void 0 : _g.humidity) !== undefined,
                hasMhk2: false,
                scheduleOwner: 'adapter',
                scheduleHoldEndTime: 0,
            },
        };
        this.processZoneUpdate(zoneUpdate, 'local', updateTimestamp);
        if (this.currentStatus) {
            if (status.filterDirty !== undefined) {
                this.currentStatus.filterDirty = status.filterDirty;
            }
            if (status.defrost !== undefined) {
                this.currentStatus.defrost = status.defrost;
            }
            if (status.standby !== undefined) {
                this.currentStatus.standby = status.standby;
            }
            this.updateFilterMaintenance((_h = this.currentStatus.filterDirty) !== null && _h !== void 0 ? _h : false);
        }
    }
    async sendDeviceCommand(commands, origin) {
        this.lastCommandOrigin = origin;
        this.lastCommandAt = Date.now();
        if (commands.operationMode !== undefined) {
            this.lastCommandLabel = commands.operationMode === 'off' ? 'off' : commands.operationMode;
        }
        const { ok, path } = await this.dispatchCommand(commands);
        this.platform.log.info(`[CMD] ${this.accessory.displayName} <- ${origin} via ${path}` +
            `${ok ? '' : ' FAILED'}: ${JSON.stringify(commands)}`);
        return ok;
    }
    async dispatchCommand(commands) {
        const local = this.platform.localClient;
        if (local && local.hasLocal(this.deviceSerial)) {
            const ok = await local.sendCommand(this.deviceSerial, commands);
            if (ok) {
                this.lastLocalUpdateTs = Date.now();
                return { ok: true, path: 'local' };
            }
            this.platform.log.debug(`[LOCAL] ${this.accessory.displayName}: local command failed — falling back to cloud`);
        }
        return { ok: await this.kumoAPI.sendCommand(this.deviceSerial, commands), path: 'cloud' };
    }
    processZoneUpdate(zone, source, timestamp) {
        try {
            if (source !== 'local' &&
                this.lastLocalUpdateTs > 0 &&
                (Date.now() - this.lastLocalUpdateTs) < this.LOCAL_AUTHORITATIVE_MS) {
                this.platform.log.debug(`[${this.deviceSerial}] Ignoring ${source} update — local is authoritative`);
                return;
            }
            if (timestamp < this.lastUpdateTimestamp) {
                this.platform.log.debug(`[${this.deviceSerial}] Ignoring ${source} update: ` +
                    `${this.lastUpdateTimestamp - timestamp}ms older than last ${this.lastUpdateSource} update`);
                return;
            }
            this.lastUpdateTimestamp = timestamp;
            const previousSource = this.lastUpdateSource;
            this.lastUpdateSource = source;
            if (source === 'local') {
                this.lastLocalUpdateTs = timestamp;
            }
            if (previousSource !== source && previousSource !== 'none') {
                this.platform.log.debug(`[${this.deviceSerial}] Update source changed: ${previousSource} → ${source}`);
            }
            this.platform.log.debug(`Processing ${source} update for ${this.deviceSerial}`);
            if (zone.adapter.roomTemp === undefined || zone.adapter.roomTemp === null) {
                this.platform.log.error(`Device ${this.deviceSerial} has invalid roomTemp: ${zone.adapter.roomTemp}`);
                this.platform.log.debug('Zone adapter data:', JSON.stringify(zone.adapter));
                return;
            }
            const hasHumidity = zone.adapter.humidity !== null && zone.adapter.humidity !== undefined;
            if (hasHumidity && !this.hasHumiditySensor) {
                this.hasHumiditySensor = true;
                this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                    .onGet(this.getCurrentRelativeHumidity.bind(this));
                this.publishStructureChange();
                this.platform.log.debug(`Added humidity characteristic for device ${this.deviceSerial}`);
            }
            const status = {
                id: zone.id,
                deviceSerial: zone.adapter.deviceSerial,
                rssi: zone.adapter.rssi || 0,
                power: zone.adapter.power,
                operationMode: zone.adapter.operationMode,
                humidity: zone.adapter.humidity,
                fanSpeed: zone.adapter.fanSpeed,
                airDirection: zone.adapter.airDirection,
                roomTemp: zone.adapter.roomTemp,
                spCool: zone.adapter.spCool,
                spHeat: zone.adapter.spHeat,
                spAuto: zone.adapter.spAuto,
            };
            const prevLabel = powerModeLabel(this.currentStatus);
            const nextLabel = powerModeLabel(status);
            if (this.hasReceivedValidUpdate && prevLabel !== nextLabel) {
                const recentCommand = this.lastCommandOrigin !== null && (Date.now() - this.lastCommandAt) < this.ATTRIBUTION_MS;
                let cause;
                if (recentCommand && this.lastCommandLabel === nextLabel) {
                    cause = `ours (${this.lastCommandOrigin})`;
                }
                else if (recentCommand) {
                    cause =
                        `UNEXPECTED — we just sent ${this.lastCommandOrigin} (${this.lastCommandLabel}); ` +
                            'likely a stale cloud replay';
                }
                else {
                    cause = 'EXTERNAL — wall control, Kumo app, a schedule there, or the unit itself';
                }
                this.platform.log.info(`[STATE] ${this.accessory.displayName}: ${prevLabel} -> ${nextLabel} (seen via ${source}) — ${cause}`);
            }
            this.currentStatus = status;
            this.hasReceivedValidUpdate = true;
            this.platform.log.debug(`${this.accessory.displayName}: ${status.roomTemp}°C (target: ${this.getTargetTempFromStatus(status)}°C, mode: ${status.operationMode})`);
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.mapToCurrentHeatingCoolingState(status));
            this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.mapToTargetHeatingCoolingState(status));
            if (status.roomTemp !== undefined && status.roomTemp !== null && !isNaN(status.roomTemp)) {
                this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.correctTemp(status.roomTemp));
            }
            const targetTemp = this.getTargetTempFromStatus(status);
            if (targetTemp !== undefined && targetTemp !== null && !isNaN(targetTemp)) {
                this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.correctTemp(targetTemp));
            }
            if (status.spHeat !== undefined && status.spHeat !== null && !isNaN(status.spHeat)) {
                this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.correctTemp(status.spHeat));
            }
            if (status.spCool !== undefined && status.spCool !== null && !isNaN(status.spCool)) {
                this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.correctTemp(status.spCool));
            }
            if (this.hasHumiditySensor && status.humidity !== null) {
                this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, status.humidity);
            }
            if (this.fanOnlyService) {
                this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, this.isFanOnlyActive(status));
            }
            if (this.dryService) {
                this.dryService.updateCharacteristic(this.platform.Characteristic.On, this.isDryActive(status));
            }
            this.notifyStatusListeners();
        }
        catch (error) {
            this.platform.log.error('Error updating device status:', error);
        }
    }
    mapToCurrentHeatingCoolingState(status) {
        if (status.power === 0) {
            return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        }
        switch (status.operationMode) {
            case 'heat':
                return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
            case 'cool':
                return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
            case 'autoHeat':
                return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
            case 'autoCool':
                return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
            case 'auto': {
                const targetTemp = this.getTargetTempFromStatus(status);
                if (status.roomTemp > targetTemp) {
                    return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
                }
                return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
            }
            case 'dry':
            case 'vent':
                return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
            case 'off':
            default:
                return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        }
    }
    mapToTargetHeatingCoolingState(status) {
        if (status.power === 0 || status.operationMode === 'off') {
            return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
        }
        if (status.operationMode === 'heat') {
            return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
        }
        else if (status.operationMode === 'cool') {
            return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
        }
        else if (this.isAutoMode(status.operationMode)) {
            return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        }
        else if (status.operationMode === 'dry' || status.operationMode === 'vent') {
            return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
        }
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    getTargetTempFromStatus(status) {
        if (status.operationMode === 'heat' && status.spHeat !== undefined && status.spHeat !== null) {
            return status.spHeat;
        }
        else if (status.operationMode === 'cool' && status.spCool !== undefined && status.spCool !== null) {
            return status.spCool;
        }
        else if (this.isAutoMode(status.operationMode) && status.spAuto !== null && status.spAuto !== undefined) {
            return status.spAuto;
        }
        else if (status.operationMode === 'dry' &&
            this.dryUsesSetpoint() &&
            status.spCool !== undefined &&
            status.spCool !== null) {
            return status.spCool;
        }
        if (status.spHeat !== undefined && status.spHeat !== null) {
            return status.spHeat;
        }
        return 20;
    }
    isAutoMode(operationMode) {
        return operationMode.startsWith('auto');
    }
    dryUsesSetpoint() {
        return this.deviceProfile === null || this.deviceProfile.usesSetPointInDryMode;
    }
    noteModeIntent(operationMode) {
        this.offRequestedAt = operationMode === 'off' ? Date.now() : 0;
    }
    async holdSetpointWrite(key) {
        const gen = (this.setpointWriteGen.get(key) || 0) + 1;
        this.setpointWriteGen.set(key, gen);
        await new Promise(resolve => setTimeout(resolve, this.SETPOINT_HOLD_MS));
        if (this.setpointWriteGen.get(key) !== gen) {
            return 'superseded';
        }
        return this.shouldSuppressSetpoint() ? 'suppressed' : 'send';
    }
    shouldSuppressSetpoint() {
        if (!this.currentStatus) {
            return false;
        }
        return (this.currentStatus.power === 0 ||
            this.currentStatus.operationMode === 'off' ||
            Date.now() - this.offRequestedAt < this.OFF_SUPPRESS_WINDOW_MS);
    }
    async getCurrentHeatingCoolingState() {
        if (!this.currentStatus) {
            this.platform.log.debug('No status available yet for getCurrentHeatingCoolingState, returning OFF');
            return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        }
        const state = this.mapToCurrentHeatingCoolingState(this.currentStatus);
        this.platform.log.debug('Get CurrentHeatingCoolingState:', state);
        return state;
    }
    async getTargetHeatingCoolingState() {
        if (!this.currentStatus) {
            this.platform.log.debug('No status available yet for getTargetHeatingCoolingState, returning OFF');
            return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
        }
        const state = this.mapToTargetHeatingCoolingState(this.currentStatus);
        this.platform.log.debug('Get TargetHeatingCoolingState:', state);
        return state;
    }
    async setTargetHeatingCoolingState(value) {
        this.platform.log.debug('Set TargetHeatingCoolingState:', value);
        let operationMode;
        let modeName;
        switch (value) {
            case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
                operationMode = 'off';
                modeName = 'OFF';
                break;
            case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
                operationMode = 'heat';
                modeName = 'HEAT';
                break;
            case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
                operationMode = 'cool';
                modeName = 'COOL';
                break;
            case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
                operationMode = 'auto';
                modeName = 'AUTO';
                break;
            default:
                this.platform.log.error('Unknown target heating cooling state:', value);
                return;
        }
        this.platform.log.info(`[MODE CHANGE] ${this.accessory.displayName}: HomeKit sent ${modeName} mode`);
        this.noteModeIntent(operationMode);
        const success = await this.sendDeviceCommand({ operationMode }, 'homekit:mode');
        if (success) {
            this.platform.log.info(`[MODE CHANGE] ${this.accessory.displayName}: Command accepted by API`);
            if (this.currentStatus) {
                this.currentStatus.operationMode = operationMode;
                this.currentStatus.power = operationMode === 'off' ? 0 : 1;
            }
            if (this.fanOnlyService) {
                this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, false);
            }
            if (this.dryService) {
                this.dryService.updateCharacteristic(this.platform.Characteristic.On, false);
            }
            this.notifyStatusListeners();
        }
        else {
            this.platform.log.error(`[MODE CHANGE] ${this.accessory.displayName}: Failed to set mode to ${modeName}`);
        }
    }
    async getCurrentTemperature() {
        if (!this.currentStatus) {
            this.platform.log.debug('No status available yet for getCurrentTemperature, returning default');
            return 20;
        }
        const temp = this.currentStatus.roomTemp;
        if (temp === undefined || temp === null || isNaN(temp)) {
            if (this.hasReceivedValidUpdate) {
                this.platform.log.warn(`Invalid roomTemp value for ${this.accessory.displayName}:`, temp);
            }
            return 20;
        }
        this.platform.log.debug(`HomeKit get current temp for ${this.accessory.displayName}: ${temp}°C`);
        return this.correctTemp(temp);
    }
    async getTargetTemperature() {
        if (!this.currentStatus) {
            this.platform.log.debug('No status available yet for getTargetTemperature, returning default');
            return 20;
        }
        const temp = this.getTargetTempFromStatus(this.currentStatus);
        if (temp === undefined || temp === null || isNaN(temp)) {
            if (this.hasReceivedValidUpdate) {
                this.platform.log.warn(`Invalid target temperature value for ${this.accessory.displayName}:`, temp);
            }
            return 20;
        }
        this.platform.log.debug(`HomeKit get target temp for ${this.accessory.displayName}: ${temp}°C`);
        return this.correctTemp(temp);
    }
    async setTargetTemperature(value) {
        const temp = value;
        const tempF = (temp * 9 / 5) + 32;
        this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: HomeKit sent ${temp.toFixed(3)}°C (${tempF.toFixed(1)}°F)`);
        if (!this.currentStatus) {
            this.platform.log.error('Cannot set temperature - no current status');
            return;
        }
        if (this.shouldSuppressSetpoint()) {
            this.platform.log.debug(`[TEMP CHANGE] ${this.accessory.displayName}: unit is off / turning off — caching ${temp}°C without sending (avoids a doomed 400 and a setpoint that would revive the unit)`);
            this.currentStatus.spHeat = temp;
            this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, temp);
            return;
        }
        const commands = {};
        if (this.currentStatus.operationMode === 'heat') {
            commands.spHeat = temp;
        }
        else if (this.currentStatus.operationMode === 'cool') {
            commands.spCool = temp;
        }
        else if (this.isAutoMode(this.currentStatus.operationMode)) {
            commands.spHeat = temp;
            commands.spCool = temp;
        }
        else if (this.currentStatus.operationMode === 'dry' && this.dryUsesSetpoint()) {
            commands.spCool = temp;
        }
        else {
            commands.spHeat = temp;
        }
        const hold = await this.holdSetpointWrite('target');
        if (hold === 'superseded') {
            return;
        }
        if (hold === 'suppressed') {
            this.platform.log.debug(`[TEMP CHANGE] ${this.accessory.displayName}: unit turned off while held — caching ${temp}°C without sending`);
            if (this.currentStatus) {
                if (commands.spHeat !== undefined) {
                    this.currentStatus.spHeat = commands.spHeat;
                }
                if (commands.spCool !== undefined) {
                    this.currentStatus.spCool = commands.spCool;
                }
            }
            this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, temp);
            return;
        }
        this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: Sending to API: ${JSON.stringify(commands)}°C`);
        const success = await this.sendDeviceCommand(commands, 'homekit:temp');
        if (success) {
            this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: Command accepted by API`);
            if (this.currentStatus) {
                if (commands.spHeat !== undefined) {
                    this.currentStatus.spHeat = commands.spHeat;
                }
                if (commands.spCool !== undefined) {
                    this.currentStatus.spCool = commands.spCool;
                }
            }
            this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, temp);
            this.notifyStatusListeners();
        }
        else {
            this.platform.log.error(`Failed to set target temperature for ${this.accessory.displayName}: ${JSON.stringify(commands)}`);
        }
    }
    async getHeatingThresholdTemperature() {
        return this.getThresholdTemperature('spHeat', 20);
    }
    async getCoolingThresholdTemperature() {
        return this.getThresholdTemperature('spCool', 24);
    }
    getThresholdTemperature(field, fallback) {
        if (!this.currentStatus) {
            return fallback;
        }
        const v = this.currentStatus[field];
        if (v === undefined || v === null || isNaN(v)) {
            return fallback;
        }
        return this.correctTemp(v);
    }
    async setHeatingThresholdTemperature(value) {
        await this.setThresholdTemperature('spHeat', value);
    }
    async setCoolingThresholdTemperature(value) {
        await this.setThresholdTemperature('spCool', value);
    }
    async setThresholdTemperature(field, temp) {
        const characteristic = field === 'spHeat'
            ? this.platform.Characteristic.HeatingThresholdTemperature
            : this.platform.Characteristic.CoolingThresholdTemperature;
        const label = field === 'spHeat' ? 'AUTO HEAT SP' : 'AUTO COOL SP';
        const fallback = field === 'spHeat' ? 20 : 24;
        const tempF = (temp * 9 / 5) + 32;
        this.platform.log.info(`[${label}] ${this.accessory.displayName}: HomeKit sent ${temp.toFixed(1)}°C (${tempF.toFixed(1)}°F)`);
        if (!this.currentStatus) {
            this.platform.log.error(`[${label}] ${this.accessory.displayName}: no current status`);
            return;
        }
        if (this.shouldSuppressSetpoint()) {
            this.platform.log.debug(`[${label}] ${this.accessory.displayName}: unit is off / turning off — caching ${temp}°C without sending`);
            this.currentStatus[field] = temp;
            this.service.updateCharacteristic(characteristic, temp);
            return;
        }
        const commands = {};
        commands[field] = temp;
        const hold = await this.holdSetpointWrite(field);
        if (hold === 'superseded') {
            return;
        }
        if (hold === 'suppressed') {
            this.platform.log.debug(`[${label}] ${this.accessory.displayName}: unit turned off while held — caching ${temp}°C without sending`);
            if (this.currentStatus) {
                this.currentStatus[field] = temp;
            }
            this.service.updateCharacteristic(characteristic, temp);
            return;
        }
        const success = await this.sendDeviceCommand(commands, 'homekit:threshold');
        if (success) {
            this.platform.log.info(`[${label}] ${this.accessory.displayName}: Command accepted by API`);
            this.currentStatus[field] = temp;
            this.service.updateCharacteristic(characteristic, temp);
            this.notifyStatusListeners();
        }
        else {
            this.platform.log.error(`[${label}] ${this.accessory.displayName}: Failed to set ${field} to ${temp}`);
            setTimeout(() => {
                this.service.updateCharacteristic(characteristic, this.getThresholdTemperature(field, fallback));
            }, 100);
        }
    }
    clampSetpoint(value, mode) {
        if (typeof value !== 'number' || isNaN(value) || !this.deviceProfile) {
            return value;
        }
        const min = this.deviceProfile.minimumSetPoints[mode];
        const max = this.deviceProfile.maximumSetPoints[mode];
        if (typeof min === 'number' && value < min) {
            return min;
        }
        if (typeof max === 'number' && value > max) {
            return max;
        }
        return value;
    }
    normalizeMirrorMode(desired) {
        if (desired.power === 0 || desired.operationMode === 'off') {
            return 'off';
        }
        const m = desired.operationMode;
        if (m.startsWith('auto')) {
            return 'auto';
        }
        if (m === 'heat' || m === 'cool' || m === 'dry' || m === 'vent') {
            return m;
        }
        return 'off';
    }
    async applyMirror(desired) {
        const mode = this.normalizeMirrorMode(desired);
        if (mode === 'dry' && this.deviceProfile && !this.deviceProfile.hasModeDry) {
            this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no dry mode — skipping`);
            return;
        }
        if (mode === 'vent' && this.deviceProfile && !this.deviceProfile.hasModeVent) {
            this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no vent mode — skipping`);
            return;
        }
        const commands = {};
        const fan = desired.fanSpeed;
        switch (mode) {
            case 'off':
                commands.operationMode = 'off';
                break;
            case 'heat':
                commands.operationMode = 'heat';
                commands.spHeat = this.clampSetpoint(desired.spHeat, 'heat');
                if (fan) {
                    commands.fanSpeedRaw = fan;
                }
                break;
            case 'cool':
                commands.operationMode = 'cool';
                commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
                if (fan) {
                    commands.fanSpeedRaw = fan;
                }
                break;
            case 'auto':
                commands.operationMode = 'auto';
                commands.spHeat = this.clampSetpoint(desired.spHeat, 'auto');
                commands.spCool = this.clampSetpoint(desired.spCool, 'auto');
                if (fan) {
                    commands.fanSpeedRaw = fan;
                }
                break;
            case 'dry':
                commands.operationMode = 'dry';
                commands.power = 1;
                if (this.dryUsesSetpoint()) {
                    commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
                }
                if (fan) {
                    commands.fanSpeedRaw = fan;
                }
                break;
            case 'vent':
                commands.operationMode = 'vent';
                commands.power = 1;
                if (fan) {
                    commands.fanSpeedRaw = fan;
                }
                break;
        }
        this.platform.log.info(`[MIRROR] ${this.accessory.displayName}: applying ${JSON.stringify(commands)}`);
        this.noteModeIntent(commands.operationMode);
        const success = await this.sendDeviceCommand(commands, 'mirror');
        if (!success) {
            this.platform.log.error(`[MIRROR] ${this.accessory.displayName}: mirror command failed`);
            return;
        }
        if (this.currentStatus) {
            this.currentStatus.operationMode = commands.operationMode;
            this.currentStatus.power = commands.operationMode === 'off' ? 0 : 1;
            if (commands.spHeat !== undefined) {
                this.currentStatus.spHeat = commands.spHeat;
            }
            if (commands.spCool !== undefined) {
                this.currentStatus.spCool = commands.spCool;
            }
            if (fan) {
                this.currentStatus.fanSpeed = fan;
            }
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.mapToCurrentHeatingCoolingState(this.currentStatus));
            this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.mapToTargetHeatingCoolingState(this.currentStatus));
            const targetTemp = this.getTargetTempFromStatus(this.currentStatus);
            if (!isNaN(targetTemp)) {
                this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemp);
            }
            if (this.dryService) {
                this.dryService.updateCharacteristic(this.platform.Characteristic.On, this.isDryActive(this.currentStatus));
            }
            if (this.fanOnlyService) {
                this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, this.isFanOnlyActive(this.currentStatus));
            }
        }
    }
    async getCurrentRelativeHumidity() {
        var _a;
        if (!this.currentStatus) {
            const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
            if (status) {
                this.currentStatus = status;
            }
        }
        const humidity = ((_a = this.currentStatus) === null || _a === void 0 ? void 0 : _a.humidity) || 0;
        this.platform.log.debug('Get CurrentRelativeHumidity:', humidity);
        return humidity;
    }
    destroy() {
        this.kumoAPI.unsubscribeFromDevice(this.deviceSerial);
        this.platform.log.debug(`Unsubscribed from streaming updates for ${this.deviceSerial}`);
    }
}
exports.KumoThermostatAccessory = KumoThermostatAccessory;
