"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KumoV3Platform = void 0;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const settings_1 = require("./settings");
const kumo_api_1 = require("./kumo-api");
const cred_store_1 = require("./cred-store");
const accessory_1 = require("./accessory");
const local_api_1 = require("./local-api");
const mirror_1 = require("./mirror");
const LOCAL_CRED_INITIAL_WAIT_MS = 25000;
const LOCAL_CRED_RETRY_MS = 60000;
const LOCAL_CRED_RETRY_WAIT_MS = 10000;
class KumoV3Platform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.accessories = [];
        this.accessoryHandlers = [];
        this.sitePollers = new Map();
        this.siteAccessories = new Map();
        this.isStreamingHealthy = false;
        this.isDegradedMode = false;
        this.localClient = null;
        this.localPollTimer = null;
        this.localSerials = [];
        this.localCredRetryTimer = null;
        this.localCredRetryRunning = false;
        this.legacyCredAttempts = new Map();
        this.credStorePath = null;
        this.credStore = new Map();
        this.mirror = null;
        this.modeChangeHysteresisMs = 10000;
        this.pendingModeChange = null;
        this.pendingModeHealthy = null;
        this.discoveryRetryTimer = null;
        this.discoveryRetryDelayMs = 30000;
        this.discoveryRetryBaseMs = 30000;
        this.discoveryRetryMaxMs = 300000;
        this.FakeGatoHistoryService = null;
        this.kumoConfig = config;
        this.log.debug('Initializing platform:', this.config.name);
        const kumoConfig = this.kumoConfig;
        if (!kumoConfig.username || !kumoConfig.password) {
            this.log.error('Username and password are required in config');
            throw new Error('Missing required configuration');
        }
        if (typeof kumoConfig.username !== 'string' || !kumoConfig.username.includes('@')) {
            this.log.error('Username must be a valid email address');
            throw new Error('Invalid username format');
        }
        if (typeof kumoConfig.password !== 'string' || kumoConfig.password.trim().length === 0) {
            this.log.error('Password must be a non-empty string');
            throw new Error('Invalid password format');
        }
        if (kumoConfig.pollInterval !== undefined) {
            if (typeof kumoConfig.pollInterval !== 'number' || kumoConfig.pollInterval < 5) {
                this.log.error('Poll interval must be a number >= 5 seconds');
                throw new Error('Invalid poll interval');
            }
        }
        this.degradedPollInterval = (kumoConfig.degradedPollInterval || 10) * 1000;
        this.log.debug(`Degraded polling interval: ${this.degradedPollInterval / 1000}s`);
        this.kumoAPI = new kumo_api_1.KumoAPI(kumoConfig.username, kumoConfig.password, this.log, kumoConfig.debug || false);
        const healthCheckInterval = kumoConfig.streamingHealthCheckInterval || 30;
        this.kumoAPI.setStreamingHealthCheckInterval(healthCheckInterval);
        this.kumoAPI.onStreamingHealthChange((isHealthy) => {
            this.handleStreamingHealthChange(isHealthy);
        });
        if (this.kumoConfig.enableHistory) {
            try {
                this.FakeGatoHistoryService = require('fakegato-history')(this.api);
                this.log.info('Eve history logging enabled');
            }
            catch (e) {
                this.log.error('Failed to load fakegato-history — history disabled:', e);
            }
        }
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            this.discoverDevices();
        });
        this.api.on('shutdown', () => {
            log.debug('Shutting down platform');
            this.cleanup();
        });
    }
    cleanup() {
        if (this.discoveryRetryTimer) {
            clearTimeout(this.discoveryRetryTimer);
            this.discoveryRetryTimer = null;
        }
        if (this.localPollTimer) {
            clearInterval(this.localPollTimer);
            this.localPollTimer = null;
        }
        this.stopLocalCredRetry();
        if (this.mirror) {
            this.mirror.destroy();
            this.mirror = null;
        }
        for (const [siteId, timer] of this.sitePollers) {
            clearInterval(timer);
            this.log.debug(`Stopped site poller for ${siteId}`);
        }
        this.sitePollers.clear();
        for (const handler of this.accessoryHandlers) {
            handler.destroy();
        }
        this.accessoryHandlers.length = 0;
        this.kumoAPI.destroy();
    }
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
    }
    async discoverDevices() {
        const success = await this.attemptDiscovery();
        if (success) {
            if (this.discoveryRetryTimer) {
                clearTimeout(this.discoveryRetryTimer);
                this.discoveryRetryTimer = null;
            }
            this.discoveryRetryDelayMs = this.discoveryRetryBaseMs;
            return;
        }
        this.scheduleDiscoveryRetry();
    }
    scheduleDiscoveryRetry() {
        if (this.discoveryRetryTimer) {
            return;
        }
        const delaySec = Math.round(this.discoveryRetryDelayMs / 1000);
        this.log.warn(`Device discovery did not complete - retrying in ${delaySec}s`);
        this.discoveryRetryTimer = setTimeout(() => {
            this.discoveryRetryTimer = null;
            this.discoverDevices();
        }, this.discoveryRetryDelayMs);
        this.discoveryRetryDelayMs = Math.min(this.discoveryRetryDelayMs * 2, this.discoveryRetryMaxMs);
    }
    async attemptDiscovery() {
        var _a, _b;
        try {
            this.log.info('Starting device discovery');
            const loginSuccess = await this.kumoAPI.login();
            if (!loginSuccess) {
                this.log.error('Failed to login to Kumo Cloud API');
                return false;
            }
            const sites = await this.kumoAPI.getSites();
            if (sites.length === 0) {
                this.log.warn('No sites found');
                return false;
            }
            this.log.info(`Found ${sites.length} site(s)`);
            const discoveredDevices = [];
            for (const site of sites) {
                this.log.debug(`Fetching zones for site: ${site.name}`);
                const zones = await this.kumoAPI.getZones(site.id);
                for (const zone of zones) {
                    if (!zone.isActive) {
                        this.log.debug(`Skipping inactive zone: ${zone.name}`);
                        continue;
                    }
                    const deviceSerial = zone.adapter.deviceSerial;
                    const displayName = zone.name;
                    if ((_a = this.kumoConfig.excludeDevices) === null || _a === void 0 ? void 0 : _a.includes(deviceSerial)) {
                        this.log.info(`Hiding device from HomeKit: ${displayName} (${deviceSerial})`);
                        continue;
                    }
                    const uuid = this.api.hap.uuid.generate(deviceSerial);
                    discoveredDevices.push({
                        uuid,
                        displayName,
                        deviceSerial,
                        zoneName: zone.name,
                    });
                    this.log.info(`Discovered device: ${displayName} (${deviceSerial})`);
                    if (this.accessoryHandlers.some(handler => handler.getDeviceSerial() === deviceSerial)) {
                        this.log.debug(`Handler already initialized for ${deviceSerial}, skipping`);
                        continue;
                    }
                    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
                    if (existingAccessory) {
                        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                        if (existingAccessory.displayName !== displayName) {
                            this.log.info(`Zone renamed in Kumo: '${existingAccessory.displayName}' -> '${displayName}' (${deviceSerial})`);
                            existingAccessory.displayName = displayName;
                            (_b = existingAccessory.getService(this.Service.AccessoryInformation)) === null || _b === void 0 ? void 0 : _b.updateCharacteristic(this.Characteristic.Name, displayName);
                        }
                        existingAccessory.context.device = {
                            deviceSerial,
                            zoneName: zone.name,
                            displayName,
                            siteId: site.id,
                        };
                        const handler = new accessory_1.KumoThermostatAccessory(this, existingAccessory, this.kumoAPI, this.kumoConfig.pollInterval);
                        this.accessoryHandlers.push(handler);
                        this.api.updatePlatformAccessories([existingAccessory]);
                    }
                    else {
                        this.log.info('Adding new accessory:', displayName);
                        const accessory = new this.api.platformAccessory(displayName, uuid);
                        accessory.context.device = {
                            deviceSerial,
                            zoneName: zone.name,
                            displayName,
                            siteId: site.id,
                        };
                        const handler = new accessory_1.KumoThermostatAccessory(this, accessory, this.kumoAPI, this.kumoConfig.pollInterval);
                        this.accessoryHandlers.push(handler);
                        this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                        this.accessories.push(accessory);
                    }
                }
            }
            if (discoveredDevices.length === 0) {
                this.log.warn('No devices discovered - likely a transient API failure; will retry');
                return false;
            }
            const staleAccessories = this.accessories.filter(accessory => !discoveredDevices.find(device => device.uuid === accessory.UUID));
            if (staleAccessories.length > 0) {
                this.log.info(`Removing ${staleAccessories.length} stale accessory(ies)`);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, staleAccessories);
            }
            this.log.info('Device discovery completed');
            const allDeviceSerials = discoveredDevices.map(d => d.deviceSerial);
            if (allDeviceSerials.length > 0) {
                this.log.info('Starting streaming for real-time updates...');
                const streamingStarted = await this.kumoAPI.startStreaming(allDeviceSerials);
                if (streamingStarted) {
                    this.log.info('✓ Streaming enabled - devices will update in real-time');
                }
                else {
                    this.log.warn('Streaming failed to start - falling back to polling');
                }
                const healthCheckInterval = this.kumoConfig.streamingHealthCheckInterval || 30;
                this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                this.log.info('Mitsubishi Comfort Plugin Configuration');
                this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                this.log.info(`Streaming: ${streamingStarted ? 'ENABLED' : 'DISABLED'}`);
                this.log.info(`Polling mode: ${this.kumoConfig.disablePolling ? 'On-demand only' : 'Enabled'}`);
                this.log.info(`Normal poll interval: ${(this.kumoConfig.pollInterval || 30)}s`);
                this.log.info(`Degraded poll interval: ${this.degradedPollInterval / 1000}s`);
                this.log.info(`Health check interval: ${healthCheckInterval}s`);
                this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                if (streamingStarted) {
                    if (this.kumoConfig.disablePolling) {
                        this.log.info('Strategy: Streaming primary, polling fallback only');
                    }
                    else {
                        this.log.info('Strategy: Streaming primary, polling supplemental');
                    }
                }
                if (this.kumoConfig.localControl) {
                    this.initLocalControl(allDeviceSerials).catch(err => this.log.error('Local control setup failed:', err));
                }
            }
            if (!this.kumoConfig.disablePolling) {
                const uniqueSites = new Set(discoveredDevices.map(d => { var _a; return (_a = this.accessories.find(a => a.UUID === d.uuid)) === null || _a === void 0 ? void 0 : _a.context.device.siteId; }).filter(Boolean));
                this.log.info(`Initializing pollers for ${uniqueSites.size} site(s)`);
                for (const siteId of uniqueSites) {
                    this.startSitePoller(siteId);
                }
            }
            else {
                this.log.info('Polling disabled - will activate only if streaming fails');
            }
            if (!this.mirror && this.kumoConfig.mirror && this.kumoConfig.mirror.length > 0) {
                this.mirror = new mirror_1.MirrorController(this.log, this.kumoConfig.mirror, this.accessoryHandlers);
                this.log.info(`Device mirroring enabled for ${this.kumoConfig.mirror.length} pair(s)`);
            }
            return true;
        }
        catch (error) {
            this.log.error('Error during device discovery:', error);
            return false;
        }
    }
    async initLocalControl(serials) {
        this.log.info('Local control enabled — gathering credentials...');
        this.localClient = new local_api_1.LocalKumoClient(this.log);
        this.localSerials = serials;
        this.initCredStore();
        const creds = await this.gatherLocalCreds(serials, LOCAL_CRED_INITIAL_WAIT_MS);
        if (creds.size > 0) {
            this.log.info(`Local control: credentials for ${creds.size}/${serials.length} device(s)`);
            await this.admitLocalDevices(creds);
        }
        else {
            this.log.warn('Local control: no credentials obtained yet — staying on cloud for now');
        }
        const localCount = this.countLocalDevices();
        if (localCount > 0) {
            this.log.info(`✓ Local control active for ${localCount}/${serials.length} device(s)`);
            this.startLocalPolling();
        }
        else {
            this.log.warn('Local control: no devices reachable on the LAN — staying on cloud');
        }
        this.scheduleLocalCredRetry();
    }
    async gatherLocalCreds(serials, waitMs) {
        for (const serial of serials) {
            this.kumoAPI.requestAdapterStatus(serial);
        }
        const creds = new Map();
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && creds.size < serials.length) {
            for (const serial of serials) {
                if (creds.has(serial)) {
                    continue;
                }
                const password = this.kumoAPI.getAdapterPassword(serial);
                if (!password) {
                    continue;
                }
                const cryptoSerial = await this.kumoAPI.getDeviceCryptoSerial(serial);
                if (cryptoSerial) {
                    creds.set(serial, { password, cryptoSerial });
                }
            }
            if (creds.size < serials.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                for (const serial of serials) {
                    if (!creds.has(serial)) {
                        this.kumoAPI.requestAdapterStatus(serial);
                    }
                }
            }
        }
        for (const [serial, c] of creds) {
            this.persistCred(serial, c);
        }
        const missing = serials.filter(s => !creds.has(s));
        if (missing.length > 0) {
            this.fillFromStoredCreds(missing, creds);
        }
        const stillMissing = serials.filter(s => !creds.has(s));
        if (stillMissing.length > 0) {
            await this.fillFromLegacyCreds(stillMissing, creds);
        }
        return creds;
    }
    initCredStore() {
        var _a, _b, _c;
        try {
            const dir = (_c = (_b = (_a = this.api) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.storagePath) === null || _c === void 0 ? void 0 : _c.call(_b);
            if (!dir) {
                return;
            }
            this.credStorePath = path.join(dir, 'mitsubishi-comfort-local-creds.json');
            this.credStore = (0, cred_store_1.loadCredStore)(this.credStorePath, this.log);
            if (this.credStore.size > 0) {
                this.log.info(`Local control: credential store holds ${this.credStore.size} device(s)`);
            }
        }
        catch (e) {
            this.log.debug(`Credential store unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    persistCred(serial, c) {
        if (!this.credStorePath) {
            return;
        }
        const prev = this.credStore.get(serial);
        if (prev && prev.password === c.password && prev.cryptoSerial === c.cryptoSerial) {
            return;
        }
        this.credStore.set(serial, {
            password: c.password, cryptoSerial: c.cryptoSerial, capturedAt: new Date().toISOString(),
        });
        (0, cred_store_1.saveCredStore)(this.credStorePath, this.credStore, this.log);
        this.log.info(`[LOCAL] ${serial}: credentials persisted to the local store`);
    }
    fillFromStoredCreds(missing, creds) {
        for (const serial of missing) {
            const candidate = this.credStore.get(serial);
            if (!candidate) {
                continue;
            }
            const prior = this.legacyCredAttempts.get(serial);
            const samePassword = (prior === null || prior === void 0 ? void 0 : prior.password) === candidate.password;
            if (samePassword && prior.attempts >= KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS) {
                continue;
            }
            const attempts = samePassword ? prior.attempts + 1 : 1;
            this.legacyCredAttempts.set(serial, { password: candidate.password, attempts });
            creds.set(serial, { password: candidate.password, cryptoSerial: candidate.cryptoSerial });
            this.log.info(`[LOCAL] ${serial}: using stored credentials captured ${candidate.capturedAt} ` +
                `(attempt ${attempts}/${KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS}; the signed discovery probe validates them)`);
        }
    }
    async fillFromLegacyCreds(missing, creds) {
        let legacy;
        try {
            legacy = await this.kumoAPI.fetchLegacyCredentials();
        }
        catch (e) {
            this.log.debug(`Legacy credential fallback unavailable: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        for (const serial of missing) {
            const candidate = legacy.get(serial);
            if (!candidate) {
                continue;
            }
            const prior = this.legacyCredAttempts.get(serial);
            const samePassword = (prior === null || prior === void 0 ? void 0 : prior.password) === candidate.password;
            if (samePassword && prior.attempts >= KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS) {
                continue;
            }
            const attempts = samePassword ? prior.attempts + 1 : 1;
            this.legacyCredAttempts.set(serial, { password: candidate.password, attempts });
            creds.set(serial, { password: candidate.password, cryptoSerial: candidate.cryptoSerial });
            this.log.info(`[LOCAL] ${serial}: socket push never delivered credentials — trying the legacy v2 copy ` +
                `(attempt ${attempts}/${KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS}; the signed discovery probe validates it)`);
        }
    }
    async admitLocalDevices(creds) {
        if (!this.localClient) {
            return;
        }
        const manual = this.kumoConfig.localControlIps || {};
        const toDiscover = new Map();
        for (const [serial, c] of creds) {
            if (manual[serial]) {
                this.localClient.setCreds(serial, { ...c, ip: manual[serial] });
                this.log.info(`Local control: ${serial} -> ${manual[serial]} (configured)`);
            }
            else {
                toDiscover.set(serial, c);
            }
        }
        if (toDiscover.size === 0) {
            return;
        }
        const hostIp = this.getHostIpv4();
        if (!hostIp) {
            this.log.warn('Local control: could not determine the host LAN subnet for discovery');
            return;
        }
        const candidates = (0, local_api_1.enumerateSubnet)(hostIp);
        this.log.info(`Local control: sweeping ${candidates.length} addresses on ${hostIp}'s subnet...`);
        const ips = await (0, local_api_1.discoverDeviceIps)(this.log, candidates, toDiscover);
        for (const [serial, ip] of ips) {
            const c = toDiscover.get(serial);
            this.localClient.setCreds(serial, { ...c, ip });
            this.persistCred(serial, c);
        }
    }
    countLocalDevices() {
        if (!this.localClient) {
            return 0;
        }
        return this.localSerials.filter(serial => this.localClient.hasLocal(serial)).length;
    }
    pendingLocalSerials() {
        if (!this.localClient) {
            return [];
        }
        return this.localSerials.filter(serial => !this.localClient.hasLocal(serial));
    }
    scheduleLocalCredRetry() {
        if (this.localCredRetryTimer || this.pendingLocalSerials().length === 0) {
            return;
        }
        this.localCredRetryTimer = setInterval(() => {
            void this.retryLocalCreds();
        }, LOCAL_CRED_RETRY_MS);
    }
    async retryLocalCreds() {
        if (this.localCredRetryRunning || !this.localClient) {
            return;
        }
        const pending = this.pendingLocalSerials();
        if (pending.length === 0) {
            this.stopLocalCredRetry();
            return;
        }
        this.localCredRetryRunning = true;
        try {
            const creds = await this.gatherLocalCreds(pending, LOCAL_CRED_RETRY_WAIT_MS);
            if (creds.size === 0) {
                this.log.debug(`Local control: still waiting on ${pending.length} device(s)`);
                return;
            }
            this.log.info(`Local control: credentials arrived for ${creds.size} more device(s)`);
            await this.admitLocalDevices(creds);
            const localCount = this.countLocalDevices();
            if (localCount > 0) {
                this.log.info(`✓ Local control active for ${localCount}/${this.localSerials.length} device(s)`);
                this.startLocalPolling();
            }
            if (this.pendingLocalSerials().length === 0) {
                this.stopLocalCredRetry();
            }
        }
        catch (error) {
            this.log.debug(`Local control retry failed: ${error.message}`);
        }
        finally {
            this.localCredRetryRunning = false;
        }
    }
    stopLocalCredRetry() {
        if (this.localCredRetryTimer) {
            clearInterval(this.localCredRetryTimer);
            this.localCredRetryTimer = null;
        }
    }
    getHostIpv4() {
        const ifaces = os.networkInterfaces();
        let fallback = null;
        for (const name of Object.keys(ifaces)) {
            for (const ni of ifaces[name] || []) {
                if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) {
                    continue;
                }
                if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
                    return ni.address;
                }
                fallback = fallback || ni.address;
            }
        }
        return fallback;
    }
    startLocalPolling() {
        if (this.localPollTimer) {
            return;
        }
        const interval = (this.kumoConfig.localPollInterval || 15) * 1000;
        this.log.info(`Local status polling every ${interval / 1000}s`);
        const poll = async () => {
            if (!this.localClient) {
                return;
            }
            for (const handler of this.accessoryHandlers) {
                const serial = handler.getDeviceSerial();
                if (!this.localClient.hasLocal(serial)) {
                    continue;
                }
                try {
                    const status = await this.localClient.getStatus(serial);
                    if (status) {
                        handler.updateFromLocal(status);
                    }
                }
                catch (error) {
                    this.log.debug(`Local poll error for ${serial}: ${error.message}`);
                }
            }
        };
        poll();
        this.localPollTimer = setInterval(poll, interval);
    }
    startSitePoller(siteId) {
        if (this.sitePollers.has(siteId)) {
            return;
        }
        if (this.isStreamingHealthy && this.kumoConfig.disablePolling) {
            this.log.info(`Skipping poller for site ${siteId} (streaming healthy, polling disabled)`);
            return;
        }
        const interval = this.isDegradedMode ? this.degradedPollInterval : (this.kumoConfig.pollInterval || 30) * 1000;
        const intervalSec = interval / 1000;
        const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';
        this.log.info(`Starting ${mode} poller for site ${siteId}: ${intervalSec}s intervals`);
        const accessories = this.accessoryHandlers.filter(handler => handler.getSiteId() === siteId);
        this.siteAccessories.set(siteId, accessories);
        this.pollSite(siteId);
        const timer = setInterval(() => {
            this.pollSite(siteId);
        }, interval);
        this.sitePollers.set(siteId, timer);
    }
    async pollSite(siteId) {
        try {
            const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';
            const health = this.isStreamingHealthy ? 'healthy' : 'unhealthy';
            this.log.debug(`[${mode}] Polling site ${siteId} (streaming: ${health})`);
            const zones = await this.kumoAPI.getZones(siteId);
            const accessories = this.siteAccessories.get(siteId) || [];
            for (const handler of accessories) {
                const zone = zones.find(z => z.adapter.deviceSerial === handler.getDeviceSerial());
                if (zone) {
                    handler.updateFromZone(zone);
                }
                else {
                    this.log.warn(`Zone not found for device: ${handler.getDeviceSerial()}`);
                }
            }
        }
        catch (error) {
            this.log.error(`Error polling site ${siteId}:`, error);
        }
    }
    handleStreamingHealthChange(isHealthy) {
        const wasHealthy = this.isStreamingHealthy;
        this.isStreamingHealthy = isHealthy;
        if (wasHealthy && !isHealthy) {
            if (this.pendingModeChange) {
                clearTimeout(this.pendingModeChange);
                this.pendingModeChange = null;
                this.pendingModeHealthy = null;
                this.log.debug('Cancelled pending mode change due to new disconnect');
            }
            this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            this.log.warn('⚠ STREAMING INTERRUPTED');
            this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            this.enterDegradedMode();
        }
        if (!wasHealthy && isHealthy) {
            if (this.pendingModeHealthy === true) {
                this.log.debug('Mode change to healthy already pending, waiting for stability...');
                return;
            }
            if (this.pendingModeChange) {
                clearTimeout(this.pendingModeChange);
            }
            this.pendingModeHealthy = true;
            const hysteresisSec = this.modeChangeHysteresisMs / 1000;
            this.log.info(`Streaming reconnected - waiting ${hysteresisSec}s for stable connection...`);
            this.pendingModeChange = setTimeout(() => {
                this.pendingModeChange = null;
                this.pendingModeHealthy = null;
                if (this.isStreamingHealthy) {
                    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    this.log.info('✓ STREAMING RESUMED (stable)');
                    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    this.exitDegradedMode();
                }
                else {
                    this.log.warn('Streaming became unhealthy during stability check, staying in degraded mode');
                }
            }, this.modeChangeHysteresisMs);
        }
    }
    enterDegradedMode() {
        if (this.isDegradedMode) {
            return;
        }
        this.isDegradedMode = true;
        const intervalSec = this.degradedPollInterval / 1000;
        this.log.warn(`→ Switching to DEGRADED MODE`);
        this.log.warn(`→ Polling activated: ${intervalSec}s intervals`);
        this.log.warn(`→ Updates will continue via API polling`);
        if (this.kumoConfig.disablePolling) {
            this.log.warn('→ Overriding disablePolling setting for fallback');
        }
        this.restartAllPollers(this.degradedPollInterval);
    }
    exitDegradedMode() {
        if (!this.isDegradedMode) {
            return;
        }
        this.isDegradedMode = false;
        if (this.kumoConfig.disablePolling) {
            this.log.info('→ Returning to NORMAL MODE');
            this.log.info('→ Polling halted (streaming active)');
            this.log.info('→ Updates resume via real-time streaming');
            this.stopAllPollers();
        }
        else {
            const normalInterval = (this.kumoConfig.pollInterval || 30) * 1000;
            const normalSec = normalInterval / 1000;
            this.log.info('→ Returning to NORMAL MODE');
            this.log.info(`→ Polling reduced to ${normalSec}s intervals`);
            this.log.info('→ Primary updates via streaming');
            this.restartAllPollers(normalInterval);
        }
    }
    restartAllPollers(intervalMs) {
        const intervalSec = intervalMs / 1000;
        for (const [siteId, timer] of this.sitePollers) {
            clearInterval(timer);
            this.pollSite(siteId);
            const newTimer = setInterval(() => {
                this.pollSite(siteId);
            }, intervalMs);
            this.sitePollers.set(siteId, newTimer);
            this.log.debug(`Poller restarted for site ${siteId}: ${intervalSec}s interval`);
        }
        const siteCount = this.sitePollers.size;
        this.log.info(`✓ ${siteCount} site poller(s) active at ${intervalSec}s intervals`);
    }
    stopAllPollers() {
        for (const [siteId, timer] of this.sitePollers) {
            clearInterval(timer);
            this.log.debug(`Poller stopped for site ${siteId}`);
        }
        this.sitePollers.clear();
        this.log.info('✓ All polling halted');
    }
}
exports.KumoV3Platform = KumoV3Platform;
KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS = 3;
