"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KumoAPI = exports.toCloudCommands = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
const socket_io_client_1 = require("socket.io-client");
const settings_1 = require("./settings");
function toCloudCommands(commands) {
    if (commands.fanSpeedRaw === undefined) {
        return commands;
    }
    const wire = { ...commands };
    if (wire.fanSpeed === undefined) {
        wire.fanSpeed = wire.fanSpeedRaw;
    }
    delete wire.fanSpeedRaw;
    return wire;
}
exports.toCloudCommands = toCloudCommands;
class KumoAPI {
    constructor(username, password, log, debug = false, enableStreaming = true) {
        this.username = username;
        this.password = password;
        this.log = log;
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAt = 0;
        this.refreshTimer = null;
        this.debugMode = false;
        this.refreshInProgress = null;
        this.socket = null;
        this.streamingEnabled = true;
        this.deviceUpdateCallbacks = new Map();
        this.deviceProfiles = new Map();
        this.deviceConnectionStatus = new Map();
        this.deviceProfileCallbacks = new Set();
        this.deviceConnectionCallbacks = new Set();
        this.adapterPasswords = new Map();
        this.legacyCredsCache = null;
        this.legacyCredsFetchedAt = 0;
        this.adapterPasswordCallbacks = new Set();
        this.streamingHealthCallbacks = new Set();
        this.healthCheckTimer = null;
        this.streamingHealthCheckInterval = 30000;
        this.isStreamingHealthy = false;
        this.isReconnecting = false;
        this.refreshRetryCount = 0;
        this.lastRefreshAttempt = 0;
        this.loginRetryCount = 0;
        this.lastLoginAttempt = 0;
        this.maxRetryAttempts = 5;
        this.baseRetryDelay = 5000;
        this.minLoginInterval = 10000;
        this.debugMode = debug;
        this.streamingEnabled = enableStreaming;
        if (this.debugMode) {
            this.log.info('Debug mode enabled');
            this.log.warn('Debug mode may log sensitive information - use only for troubleshooting');
        }
        if (this.streamingEnabled) {
            this.log.info('Streaming mode enabled - real-time updates will be used');
        }
    }
    maskToken(token) {
        if (!token) {
            return 'null';
        }
        if (token.length <= 8) {
            return '***';
        }
        return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
    }
    async login() {
        var _a;
        const timeSinceLastLogin = Date.now() - this.lastLoginAttempt;
        if (this.lastLoginAttempt > 0 && timeSinceLastLogin < this.minLoginInterval) {
            const waitTime = this.minLoginInterval - timeSinceLastLogin;
            this.log.warn(`Rate limit protection: waiting ${Math.round(waitTime / 1000)}s before login attempt`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastLoginAttempt = Date.now();
        try {
            this.log.debug('Attempting to login to Kumo Cloud API');
            const response = await (0, node_fetch_1.default)(`${settings_1.API_BASE_URL}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-App-Version': settings_1.APP_VERSION,
                },
                body: JSON.stringify({
                    username: this.username,
                    password: this.password,
                    appVersion: settings_1.APP_VERSION,
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 429) {
                    this.loginRetryCount++;
                    this.log.error(`Login rate limited (429). Retry count: ${this.loginRetryCount}`);
                    if (this.loginRetryCount >= this.maxRetryAttempts) {
                        this.log.error(`Login retry limit reached (${this.maxRetryAttempts} attempts). Giving up.`);
                        this.loginRetryCount = 0;
                        return false;
                    }
                    const backoffDelay = Math.min(this.baseRetryDelay * Math.pow(2, this.loginRetryCount), 120000);
                    this.log.warn(`Retrying login in ${Math.round(backoffDelay / 1000)}s...`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                    return await this.login();
                }
                this.log.error(`Login failed with status: ${response.status}`);
                if (this.debugMode && errorText) {
                    this.log.debug(`Login error response: ${errorText}`);
                }
                this.loginRetryCount = 0;
                return false;
            }
            const data = await response.json();
            this.accessToken = data.token.access;
            this.refreshToken = data.token.refresh;
            const wasRecovery = this.loginRetryCount > 0 || this.refreshRetryCount > 0 || ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected);
            if (this.loginRetryCount > 0) {
                this.log.info(`Login recovered after ${this.loginRetryCount} retry attempt(s)`);
            }
            else {
                this.log.info('Successfully logged in to Kumo Cloud API');
            }
            this.loginRetryCount = 0;
            this.refreshRetryCount = 0;
            this.tokenExpiresAt = Date.now() + settings_1.TOKEN_REFRESH_INTERVAL;
            if (wasRecovery) {
                await this.reconnectStreaming();
            }
            this.scheduleTokenRefresh();
            return true;
        }
        catch (error) {
            if (error instanceof Error) {
                this.log.error('Login error:', error.message);
                if (this.debugMode) {
                    this.log.debug('Login error stack:', error.stack);
                }
            }
            else {
                this.log.error('Login error: Unknown error occurred');
            }
            this.loginRetryCount = 0;
            return false;
        }
    }
    scheduleTokenRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        const baseRefreshIn = settings_1.TOKEN_REFRESH_INTERVAL - (5 * 60 * 1000);
        const jitter = Math.floor(Math.random() * 60000);
        const refreshIn = baseRefreshIn + jitter;
        this.log.debug(`Token refresh scheduled in ${Math.round(refreshIn / 1000)}s (includes ${Math.round(jitter / 1000)}s jitter)`);
        this.refreshTimer = setTimeout(async () => {
            this.log.debug('Refreshing access token');
            await this.refreshAccessToken();
        }, refreshIn);
    }
    async refreshAccessToken() {
        if (!this.refreshToken) {
            this.log.error('No refresh token available, need to login again');
            return await this.login();
        }
        const timeSinceLastAttempt = Date.now() - this.lastRefreshAttempt;
        if (this.refreshRetryCount > 0) {
            const backoffDelay = Math.min(this.baseRetryDelay * Math.pow(2, this.refreshRetryCount - 1), 60000);
            if (timeSinceLastAttempt < backoffDelay) {
                const waitTime = backoffDelay - timeSinceLastAttempt;
                this.log.warn(`Rate limit backoff: waiting ${Math.round(waitTime / 1000)}s before retry attempt ${this.refreshRetryCount + 1}/${this.maxRetryAttempts}`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        this.lastRefreshAttempt = Date.now();
        try {
            this.log.debug('Refreshing access token');
            if (this.debugMode) {
                this.log.debug(`Refresh token (masked): ${this.maskToken(this.refreshToken)}`);
                this.log.debug(`Token expires at: ${new Date(this.tokenExpiresAt).toISOString()}`);
            }
            const response = await (0, node_fetch_1.default)(`${settings_1.API_BASE_URL}/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-App-Version': settings_1.APP_VERSION,
                },
                body: JSON.stringify({
                    refresh: this.refreshToken,
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                this.log.warn(`Token refresh failed (${response.status}): ${errorText}`);
                if (response.status === 429) {
                    this.refreshRetryCount++;
                    if (this.refreshRetryCount >= this.maxRetryAttempts) {
                        this.log.error(`Rate limit retry limit reached (${this.maxRetryAttempts} attempts). Falling back to full login.`);
                        this.refreshRetryCount = 0;
                        return await this.login();
                    }
                    this.log.warn(`Rate limited. Will retry with exponential backoff (attempt ${this.refreshRetryCount}/${this.maxRetryAttempts})`);
                    return await this.refreshAccessToken();
                }
                this.log.warn('Attempting full login');
                this.refreshRetryCount = 0;
                return await this.login();
            }
            const data = await response.json();
            this.accessToken = data.access;
            this.refreshToken = data.refresh;
            this.tokenExpiresAt = Date.now() + settings_1.TOKEN_REFRESH_INTERVAL;
            if (this.refreshRetryCount > 0) {
                this.log.info(`Token refresh recovered after ${this.refreshRetryCount} retry attempt(s)`);
            }
            else {
                this.log.debug('Access token refreshed successfully');
            }
            if (this.debugMode) {
                this.log.debug(`New access token (masked): ${this.maskToken(this.accessToken)}`);
                this.log.debug(`New token expires at: ${new Date(this.tokenExpiresAt).toISOString()}`);
            }
            this.refreshRetryCount = 0;
            await this.reconnectStreaming();
            this.scheduleTokenRefresh();
            return true;
        }
        catch (error) {
            if (error instanceof Error) {
                this.log.error('Token refresh error:', error.message);
                if (this.debugMode) {
                    this.log.debug('Token refresh error stack:', error.stack);
                }
            }
            else {
                this.log.error('Token refresh error: Unknown error occurred');
            }
            this.refreshRetryCount = 0;
            this.log.warn('Falling back to full login after refresh error');
            return await this.login();
        }
    }
    async ensureAuthenticated() {
        if (!this.accessToken || Date.now() >= this.tokenExpiresAt - (5 * 60 * 1000)) {
            if (this.refreshInProgress) {
                this.log.debug('Waiting for existing token refresh to complete');
                return await this.refreshInProgress;
            }
            this.refreshInProgress = (async () => {
                try {
                    if (!this.refreshToken) {
                        return await this.login();
                    }
                    return await this.refreshAccessToken();
                }
                finally {
                    this.refreshInProgress = null;
                }
            })();
            return await this.refreshInProgress;
        }
        return true;
    }
    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-App-Version': settings_1.APP_VERSION,
        };
    }
    async makeAuthenticatedRequest(endpoint, method = 'GET', body) {
        const authenticated = await this.ensureAuthenticated();
        if (!authenticated) {
            this.log.error('Failed to authenticate');
            return null;
        }
        try {
            const options = {
                method,
                headers: this.getAuthHeaders(),
            };
            if (body) {
                options.body = JSON.stringify(body);
            }
            const url = `${settings_1.API_BASE_URL}${endpoint}`;
            if (this.debugMode) {
                this.log.info(`→ API Request: ${method} ${endpoint}`);
                if (body) {
                    this.log.info(`  Body: ${JSON.stringify(body)}`);
                }
            }
            const startTime = Date.now();
            const response = await (0, node_fetch_1.default)(url, options);
            const duration = Date.now() - startTime;
            if (response.status === 401) {
                this.log.debug('Received 401, refreshing token and retrying');
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    return null;
                }
                options.headers = this.getAuthHeaders();
                const retryResponse = await (0, node_fetch_1.default)(`${settings_1.API_BASE_URL}${endpoint}`, options);
                if (!retryResponse.ok) {
                    this.log.error(`Request failed after retry: ${retryResponse.status}`);
                    return null;
                }
                return await retryResponse.json();
            }
            if (!response.ok) {
                this.log.error(`Request failed with status: ${response.status}`);
                const errorText = await response.text();
                if (this.debugMode || response.status === 400) {
                    this.log.error(`  Error response: ${errorText}`);
                }
                return null;
            }
            const data = await response.json();
            if (this.debugMode) {
                this.log.info(`← API Response: ${response.status} (${duration}ms)`);
                if (Array.isArray(data)) {
                    this.log.info(`  Returned ${data.length} item(s)`);
                }
                else if (data && typeof data === 'object') {
                    this.log.info(`  Keys: ${Object.keys(data).join(', ')}`);
                }
            }
            return data;
        }
        catch (error) {
            if (error instanceof Error) {
                this.log.error('Request error:', error.message);
                if (this.debugMode) {
                    this.log.debug('Full error stack:', error.stack);
                }
            }
            else {
                this.log.error('Request error: Unknown error occurred');
            }
            return null;
        }
    }
    async getSites() {
        this.log.debug('Fetching sites');
        const sites = await this.makeAuthenticatedRequest('/sites');
        return sites || [];
    }
    async getZones(siteId) {
        const authenticated = await this.ensureAuthenticated();
        if (!authenticated) {
            this.log.error('Failed to authenticate');
            return [];
        }
        try {
            const endpoint = `/sites/${siteId}/zones`;
            if (this.debugMode) {
                this.log.info(`→ API Request: GET ${endpoint}`);
            }
            const startTime = Date.now();
            const response = await (0, node_fetch_1.default)(`${settings_1.API_BASE_URL}${endpoint}`, {
                headers: this.getAuthHeaders(),
            });
            const duration = Date.now() - startTime;
            if (!response.ok) {
                const errorBody = await response.text();
                this.log.error(`Failed to fetch zones for site ${siteId}: ${response.status} - ${errorBody}`);
                return [];
            }
            const zones = await response.json();
            if (this.debugMode) {
                this.log.info(`← API Response: 200 (${duration}ms)`);
                this.log.info(`  Fetched ${zones.length} zone(s) for site ${siteId}`);
                zones.forEach(zone => {
                    this.log.info(`  RAW Zone JSON for ${zone.name}:`);
                    this.log.info(JSON.stringify(zone, null, 2));
                });
                zones.forEach(zone => {
                    const a = zone.adapter;
                    this.log.info(`    ${zone.name} [${a.deviceSerial}]`);
                    this.log.info(`      Temperature: ${a.roomTemp}°C (current) → Heat: ${a.spHeat}°C, Cool: ${a.spCool}°C, Auto: ${a.spAuto}°C`);
                    this.log.info(`      Status: ${a.operationMode} mode, power=${a.power}, connected=${a.connected}`);
                    this.log.info(`      Fan: ${a.fanSpeed}, Direction: ${a.airDirection}, Humidity: ${a.humidity !== null ? a.humidity + '%' : 'N/A'}`);
                    this.log.info(`      Signal: ${a.rssi !== undefined ? a.rssi + ' dBm' : 'N/A'}`);
                });
            }
            return zones;
        }
        catch (error) {
            if (error instanceof Error) {
                this.log.error('Error fetching zones:', error.message);
            }
            else {
                this.log.error('Error fetching zones: Unknown error occurred');
            }
            return [];
        }
    }
    async getDeviceStatus(deviceSerial) {
        this.log.debug(`Fetching status for device: ${deviceSerial}`);
        const status = await this.makeAuthenticatedRequest(`/devices/${deviceSerial}/status`);
        if (this.debugMode && status) {
            this.log.info(`  RAW Device Status JSON for ${deviceSerial}:`);
            this.log.info(JSON.stringify(status, null, 2));
        }
        return status;
    }
    async sendCommand(deviceSerial, commands) {
        const wire = toCloudCommands(commands);
        this.log.debug(`Sending command to device ${deviceSerial}:`, JSON.stringify(wire));
        const request = {
            deviceSerial,
            commands: wire,
        };
        const response = await this.makeAuthenticatedRequest('/devices/send-command', 'POST', request);
        if (!response) {
            this.log.error(`Send command failed: no response from API for device ${deviceSerial}`);
            return false;
        }
        if (!response.devices || !Array.isArray(response.devices)) {
            this.log.error(`Send command failed: unexpected response format for device ${deviceSerial}`);
            if (this.debugMode) {
                this.log.debug(`Response:`, JSON.stringify(response));
            }
            return false;
        }
        if (!response.devices.includes(deviceSerial)) {
            this.log.error(`Send command failed: device ${deviceSerial} not in response devices list`);
            return false;
        }
        this.log.debug(`Command sent successfully to device ${deviceSerial}`);
        return true;
    }
    async startStreaming(deviceSerials) {
        var _a;
        if (!this.streamingEnabled) {
            this.log.debug('Streaming is disabled, skipping connection');
            return false;
        }
        if ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected) {
            this.log.debug('Streaming already connected');
            return true;
        }
        if (!this.accessToken) {
            this.log.error('Cannot start streaming: not authenticated');
            return false;
        }
        try {
            const logLevel = this.isReconnecting ? 'debug' : 'info';
            this.log[logLevel]('Starting streaming connection...');
            this.socket = (0, socket_io_client_1.io)(settings_1.SOCKET_BASE_URL, {
                transports: ['polling', 'websocket'],
                timeout: 20000,
                extraHeaders: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Accept': '*/*',
                    'User-Agent': 'kumocloud/1122',
                },
            });
            this.socket.on('connect', () => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                const isRoutineReconnect = this.isReconnecting;
                if (isRoutineReconnect) {
                    this.log.debug(`Streaming reconnected (ID: ${(_a = this.socket) === null || _a === void 0 ? void 0 : _a.id})`);
                }
                else {
                    this.log.info(`✓ Streaming connected (ID: ${(_b = this.socket) === null || _b === void 0 ? void 0 : _b.id})`);
                }
                for (const deviceSerial of deviceSerials) {
                    if (!deviceSerial || typeof deviceSerial !== 'string' || deviceSerial.trim().length === 0) {
                        this.log.warn(`Skipping invalid device serial: ${deviceSerial}`);
                        continue;
                    }
                    this.log.debug(`Subscribing to device: ${deviceSerial}`);
                    (_c = this.socket) === null || _c === void 0 ? void 0 : _c.emit('subscribe', deviceSerial);
                }
                this.isStreamingHealthy = true;
                this.notifyHealthChange(false, true);
                this.startHealthChecks();
                const userId = this.getUserIdFromToken();
                if (userId) {
                    this.log.debug(`Account-level subscribe with user ID: ${userId}`);
                    (_d = this.socket) === null || _d === void 0 ? void 0 : _d.emit('subscribe', '', userId);
                }
                if (!isRoutineReconnect) {
                    for (const deviceSerial of deviceSerials) {
                        if (!deviceSerial || typeof deviceSerial !== 'string' || deviceSerial.trim().length === 0) {
                            continue;
                        }
                        (_e = this.socket) === null || _e === void 0 ? void 0 : _e.emit('force_adapter_request', deviceSerial, 'iuStatus');
                        (_f = this.socket) === null || _f === void 0 ? void 0 : _f.emit('force_adapter_request', deviceSerial, 'profile');
                        (_g = this.socket) === null || _g === void 0 ? void 0 : _g.emit('force_adapter_request', deviceSerial, 'adapterStatus');
                    }
                    (_h = this.socket) === null || _h === void 0 ? void 0 : _h.emit('device_status_v2', '');
                    for (const deviceSerial of deviceSerials) {
                        if (!deviceSerial || typeof deviceSerial !== 'string' || deviceSerial.trim().length === 0) {
                            continue;
                        }
                        (_j = this.socket) === null || _j === void 0 ? void 0 : _j.emit('device_status_v2', deviceSerial);
                    }
                }
                if (!isRoutineReconnect) {
                    this.log.info('✓ Streaming connection established');
                    this.log.info(`Monitoring ${deviceSerials.length} device(s) for real-time updates`);
                }
            });
            this.socket.on('device_update', (data) => {
                const deviceSerial = data.deviceSerial;
                if (!deviceSerial) {
                    return;
                }
                if (this.debugMode) {
                    this.log.debug(`Stream update for ${deviceSerial}: temp=${data.roomTemp}°C, mode=${data.operationMode}, power=${data.power}`);
                    this.log.debug(`Stream update detail: ${JSON.stringify(data)}`);
                }
                const callback = this.deviceUpdateCallbacks.get(deviceSerial);
                if (callback) {
                    callback(deviceSerial, data);
                }
            });
            this.socket.on('adapter_update', (data) => {
                const serial = data.deviceSerial || 'unknown';
                const { password, ...safeData } = data;
                if (data.deviceSerial && password) {
                    this.adapterPasswords.set(data.deviceSerial, password);
                    for (const cb of this.adapterPasswordCallbacks) {
                        try {
                            cb(data.deviceSerial, password);
                        }
                        catch (e) {
                            this.log.debug('Adapter password callback error');
                        }
                    }
                }
                this.log.debug(`Adapter update for ${serial}: fw=${safeData.firmwareVersion}, rssi=${safeData.routerRssi}`);
                if (this.debugMode) {
                    this.log.debug(`Adapter update detail: ${JSON.stringify(safeData)}`);
                }
            });
            this.socket.on('device_status_v2', (data) => {
                const serial = data.deviceSerial;
                if (!serial) {
                    return;
                }
                const isConnected = data.status !== 'disconnected';
                const wasConnected = this.deviceConnectionStatus.get(serial);
                this.deviceConnectionStatus.set(serial, isConnected);
                if (!isConnected) {
                    this.log.warn(`Device ${serial} reported offline (reason: ${data.lastDisconnectedReason || 'unknown'})`);
                }
                else {
                    this.log.debug(`Device status for ${serial}: ${data.status}`);
                }
                if (wasConnected !== isConnected) {
                    for (const callback of this.deviceConnectionCallbacks) {
                        callback(serial, isConnected);
                    }
                }
            });
            this.socket.on('profile_update', (data) => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
                const serial = data.deviceSerial;
                if (!serial) {
                    return;
                }
                const profile = {
                    numberOfFanSpeeds: (_a = data.numberOfFanSpeeds) !== null && _a !== void 0 ? _a : 3,
                    hasFanSpeedAuto: (_b = data.hasFanSpeedAuto) !== null && _b !== void 0 ? _b : true,
                    hasModeDry: (_c = data.hasModeDry) !== null && _c !== void 0 ? _c : false,
                    usesSetPointInDryMode: (_d = data.usesSetPointInDryMode) !== null && _d !== void 0 ? _d : false,
                    hasModeHeat: (_e = data.hasModeHeat) !== null && _e !== void 0 ? _e : true,
                    hasModeVent: (_f = data.hasModeVent) !== null && _f !== void 0 ? _f : false,
                    hasVaneDir: (_g = data.hasVaneDir) !== null && _g !== void 0 ? _g : false,
                    hasVaneSwing: (_h = data.hasVaneSwing) !== null && _h !== void 0 ? _h : false,
                    hasDefrost: (_j = data.hasDefrost) !== null && _j !== void 0 ? _j : false,
                    hasStandby: (_k = data.hasStandby) !== null && _k !== void 0 ? _k : false,
                    minimumSetPoints: (_l = data.minimumSetPoints) !== null && _l !== void 0 ? _l : { cool: 16, heat: 16, auto: 16 },
                    maximumSetPoints: (_m = data.maximumSetPoints) !== null && _m !== void 0 ? _m : { cool: 31, heat: 31, auto: 31 },
                };
                this.deviceProfiles.set(serial, profile);
                this.log.debug(`Profile for ${serial}: temp range ${JSON.stringify(profile.minimumSetPoints)}-${JSON.stringify(profile.maximumSetPoints)}, fans=${profile.numberOfFanSpeeds}`);
                for (const callback of this.deviceProfileCallbacks) {
                    callback(serial, profile);
                }
            });
            this.socket.on('acoil_update', (data) => {
                const serial = data.deviceSerial || 'unknown';
                this.log.debug(`A-coil update for ${serial}`);
            });
            this.socket.on('disconnect', (reason) => {
                this.log.warn(`✗ Streaming disconnected: ${reason}`);
                const wasHealthy = this.isStreamingHealthy;
                this.isStreamingHealthy = false;
                this.notifyHealthChange(wasHealthy, false);
                this.stopHealthChecks();
            });
            this.socket.on('connect_error', (error) => {
                this.log.error(`Streaming connection error: ${error.message}`);
            });
            return true;
        }
        catch (error) {
            if (error instanceof Error) {
                this.log.error('Failed to start streaming:', error.message);
            }
            return false;
        }
    }
    subscribeToDevice(deviceSerial, callback) {
        var _a;
        this.deviceUpdateCallbacks.set(deviceSerial, callback);
        if ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected) {
            this.log.debug(`Subscribing to device: ${deviceSerial}`);
            this.socket.emit('subscribe', deviceSerial);
        }
    }
    unsubscribeFromDevice(deviceSerial) {
        this.deviceUpdateCallbacks.delete(deviceSerial);
    }
    isStreamingConnected() {
        var _a;
        return ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected) || false;
    }
    onDeviceProfileUpdate(callback) {
        this.deviceProfileCallbacks.add(callback);
    }
    onAdapterPassword(callback) {
        this.adapterPasswordCallbacks.add(callback);
    }
    getAdapterPassword(serial) {
        return this.adapterPasswords.get(serial);
    }
    async getDeviceCryptoSerial(serial) {
        var _a;
        const status = await this.makeAuthenticatedRequest(`/devices/${serial}/status`);
        return (_a = status === null || status === void 0 ? void 0 : status.cryptoSerial) !== null && _a !== void 0 ? _a : null;
    }
    requestAdapterStatus(serial) {
        var _a;
        (_a = this.socket) === null || _a === void 0 ? void 0 : _a.emit('force_adapter_request', serial, 'adapterStatus');
    }
    async fetchLegacyCredentials() {
        const now = Date.now();
        if (this.legacyCredsCache && (now - this.legacyCredsFetchedAt) < KumoAPI.LEGACY_CREDS_TTL_MS) {
            return this.legacyCredsCache;
        }
        const found = new Map();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await (0, node_fetch_1.default)(`${settings_1.LEGACY_API_BASE_URL}/login`, {
                method: 'POST',
                headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.username, password: this.password, appVersion: settings_1.LEGACY_APP_VERSION,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                this.log.debug(`Legacy v2 credential fetch: HTTP ${response.status}`);
                return found;
            }
            const data = await response.json();
            const walk = (node) => {
                if (Array.isArray(node)) {
                    node.forEach(walk);
                    return;
                }
                if (!node || typeof node !== 'object') {
                    return;
                }
                for (const [key, value] of Object.entries(node)) {
                    if (value && typeof value === 'object' && !Array.isArray(value)) {
                        const v = value;
                        if (typeof v.password === 'string' && typeof v.cryptoSerial === 'string') {
                            found.set(key, { password: v.password, cryptoSerial: v.cryptoSerial });
                        }
                    }
                    walk(value);
                }
            };
            walk(data);
            this.legacyCredsCache = found;
            this.legacyCredsFetchedAt = now;
            this.log.debug(`Legacy v2 credential fetch: entries for ${found.size} device(s)`);
        }
        catch (error) {
            this.log.debug(`Legacy v2 credential fetch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timer);
        }
        return found;
    }
    onDeviceConnectionStatusChange(callback) {
        this.deviceConnectionCallbacks.add(callback);
    }
    getDeviceProfile(deviceSerial) {
        return this.deviceProfiles.get(deviceSerial);
    }
    isDeviceConnected(deviceSerial) {
        var _a;
        return (_a = this.deviceConnectionStatus.get(deviceSerial)) !== null && _a !== void 0 ? _a : true;
    }
    getUserIdFromToken() {
        if (!this.accessToken) {
            return null;
        }
        try {
            const parts = this.accessToken.split('.');
            if (parts.length < 2) {
                return null;
            }
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
            return payload.id ? String(payload.id) : null;
        }
        catch (_a) {
            this.log.debug('Failed to extract user ID from JWT');
            return null;
        }
    }
    setStreamingHealthCheckInterval(checkIntervalSec) {
        this.streamingHealthCheckInterval = checkIntervalSec * 1000;
        this.log.debug(`Streaming health check interval: ${checkIntervalSec}s`);
    }
    onStreamingHealthChange(callback) {
        this.streamingHealthCallbacks.add(callback);
    }
    getStreamingHealth() {
        return this.isStreamingHealthy;
    }
    checkStreamingHealth() {
        const wasHealthy = this.isStreamingHealthy;
        this.isStreamingHealthy = this.isStreamingConnected();
        this.notifyHealthChange(wasHealthy, this.isStreamingHealthy);
    }
    notifyHealthChange(wasHealthy, isHealthy) {
        if (wasHealthy !== isHealthy) {
            if (this.isReconnecting && !isHealthy) {
                this.log.debug('Suppressing unhealthy notification during planned reconnect');
                return;
            }
            const isRoutineReconnect = this.isReconnecting;
            if (isHealthy) {
                this.isReconnecting = false;
            }
            if (isRoutineReconnect) {
                this.log.debug(`Streaming health restored after token refresh`);
            }
            else {
                this.log.info(`Streaming health changed: ${wasHealthy ? 'healthy' : 'unhealthy'} → ${isHealthy ? 'healthy' : 'unhealthy'}`);
            }
            for (const callback of this.streamingHealthCallbacks) {
                callback(isHealthy);
            }
        }
    }
    startHealthChecks() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        this.healthCheckTimer = setInterval(() => {
            this.checkStreamingHealth();
        }, this.streamingHealthCheckInterval);
        this.log.debug('Started streaming health checks');
    }
    stopHealthChecks() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
    destroy() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.stopHealthChecks();
        this.streamingHealthCallbacks.clear();
        this.log.debug('Streaming health monitoring stopped');
        if (this.socket) {
            this.log.debug('Disconnecting streaming connection');
            this.socket.disconnect();
            this.socket = null;
        }
    }
    async reconnectStreaming() {
        if (!this.streamingEnabled) {
            return;
        }
        const deviceSerials = Array.from(this.deviceUpdateCallbacks.keys());
        if (deviceSerials.length === 0) {
            this.log.debug('No devices subscribed, skipping streaming reconnect');
            return;
        }
        this.log.debug('Reconnecting streaming with refreshed token...');
        this.isReconnecting = true;
        if (this.socket) {
            this.stopHealthChecks();
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        await this.startStreaming(deviceSerials);
    }
}
exports.KumoAPI = KumoAPI;
KumoAPI.LEGACY_CREDS_TTL_MS = 6 * 60 * 60 * 1000;
