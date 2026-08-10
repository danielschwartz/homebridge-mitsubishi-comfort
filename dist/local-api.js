"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverDeviceIps = exports.enumerateSubnet = exports.LocalKumoClient = exports.mapLocalStatus = exports.buildLocalCommandBody = exports.computeLocalToken = exports.STATUS_READ_BODY = void 0;
const crypto_1 = require("crypto");
const node_fetch_1 = __importDefault(require("node-fetch"));
const W_PARAM = Buffer.from('44c73283b498d432ff25f5c8e06a016aef931e68f0a00ea710e36e6338fb22db', 'hex');
exports.STATUS_READ_BODY = Buffer.from('{"c":{"indoorUnit":{"status":{}}}}', 'utf8');
function round1(n) {
    return Math.round(n * 10) / 10;
}
function computeLocalToken(passwordB64, cryptoSerialHex, body) {
    const password = Buffer.from(passwordB64, 'base64');
    const cryptoSerial = Buffer.from(cryptoSerialHex, 'hex');
    if (cryptoSerial.length < 9) {
        throw new Error(`cryptoSerial too short (${cryptoSerial.length} bytes, need >= 9)`);
    }
    const dataHash = (0, crypto_1.createHash)('sha256').update(Buffer.concat([password, body])).digest();
    const buf = Buffer.alloc(88);
    W_PARAM.copy(buf, 0);
    dataHash.copy(buf, 32);
    buf[64] = 0x08;
    buf[65] = 0x40;
    buf[66] = 0x00;
    buf[79] = cryptoSerial[8];
    cryptoSerial.copy(buf, 80, 4, 8);
    cryptoSerial.copy(buf, 84, 0, 4);
    return (0, crypto_1.createHash)('sha256').update(buf).digest('hex');
}
exports.computeLocalToken = computeLocalToken;
function buildLocalCommandBody(commands) {
    const status = {};
    if (commands.operationMode !== undefined) {
        status.mode = commands.operationMode;
    }
    if (commands.spHeat !== undefined) {
        status.spHeat = round1(commands.spHeat);
    }
    if (commands.spCool !== undefined) {
        status.spCool = round1(commands.spCool);
    }
    if (commands.fanSpeedRaw !== undefined) {
        status.fanSpeed = commands.fanSpeedRaw;
    }
    else if (commands.fanSpeed !== undefined) {
        status.fanSpeed = mapFanSpeedToLocal(commands.fanSpeed);
    }
    return Buffer.from(JSON.stringify({ c: { indoorUnit: { status } } }), 'utf8');
}
exports.buildLocalCommandBody = buildLocalCommandBody;
function mapFanSpeedToLocal(speed) {
    switch (speed) {
        case 'auto': return 'auto';
        case 'low': return 'quiet';
        case 'medium': return 'low';
        case 'high': return 'powerful';
        default: return 'auto';
    }
}
function mapLocalStatus(local) {
    var _a, _b;
    const mode = typeof local.mode === 'string' ? local.mode : 'off';
    return {
        operationMode: mode,
        power: mode === 'off' ? 0 : 1,
        roomTemp: local.roomTemp,
        spHeat: local.spHeat,
        spCool: local.spCool,
        spAuto: null,
        fanSpeed: (_a = local.fanSpeed) !== null && _a !== void 0 ? _a : 'auto',
        airDirection: (_b = local.vaneDir) !== null && _b !== void 0 ? _b : 'auto',
        filterDirty: local.filterDirty === true,
        defrost: local.defrost === true,
        standby: local.standby === true,
        connected: true,
    };
}
exports.mapLocalStatus = mapLocalStatus;
class LocalKumoClient {
    constructor(log, timeoutMs = 6000) {
        this.log = log;
        this.timeoutMs = timeoutMs;
        this.creds = new Map();
        this.chains = new Map();
    }
    setCreds(serial, creds) {
        this.creds.set(serial, creds);
    }
    clearCreds(serial) {
        this.creds.delete(serial);
    }
    hasLocal(serial) {
        return this.creds.has(serial);
    }
    getIp(serial) {
        var _a;
        return (_a = this.creds.get(serial)) === null || _a === void 0 ? void 0 : _a.ip;
    }
    withLock(serial, fn) {
        var _a;
        const prev = (_a = this.chains.get(serial)) !== null && _a !== void 0 ? _a : Promise.resolve();
        const next = prev.catch(() => undefined).then(fn);
        this.chains.set(serial, next.catch(() => undefined));
        return next;
    }
    async request(serial, body) {
        const creds = this.creds.get(serial);
        if (!creds) {
            return null;
        }
        return this.withLock(serial, async () => {
            const token = computeLocalToken(creds.password, creds.cryptoSerial, body);
            try {
                const fetchPromise = (0, node_fetch_1.default)(`http://${creds.ip}/api?m=${token}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*',
                    },
                    body,
                });
                fetchPromise.catch(() => undefined);
                const res = await Promise.race([
                    fetchPromise,
                    new Promise((resolve) => setTimeout(() => resolve(null), this.timeoutMs)),
                ]);
                if (!res) {
                    this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: timed out after ${this.timeoutMs}ms`);
                    return null;
                }
                const json = await res.json().catch(() => null);
                if (json && json.r && typeof json.r === 'object') {
                    return json.r;
                }
                if (json && json._api_error) {
                    this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: api error ${json._api_error}`);
                }
                return null;
            }
            catch (err) {
                this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: request failed (${err.message})`);
                return null;
            }
        });
    }
    async getStatus(serial) {
        const r = await this.request(serial, exports.STATUS_READ_BODY);
        const indoorUnit = r === null || r === void 0 ? void 0 : r.indoorUnit;
        const status = indoorUnit === null || indoorUnit === void 0 ? void 0 : indoorUnit.status;
        if (!status || status.roomTemp === undefined) {
            return null;
        }
        return mapLocalStatus(status);
    }
    async sendCommand(serial, commands) {
        const body = buildLocalCommandBody(commands);
        const r = await this.request(serial, body);
        return r !== null;
    }
}
exports.LocalKumoClient = LocalKumoClient;
function enumerateSubnet(hostIpv4) {
    const m = hostIpv4.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
    if (!m) {
        return [];
    }
    const prefix = m[1];
    const self = Number(m[2]);
    const ips = [];
    for (let i = 1; i <= 254; i++) {
        if (i !== self) {
            ips.push(`${prefix}.${i}`);
        }
    }
    return ips;
}
exports.enumerateSubnet = enumerateSubnet;
async function probeIpForSerial(ip, creds, timeoutMs) {
    try {
        const token = computeLocalToken(creds.password, creds.cryptoSerial, exports.STATUS_READ_BODY);
        const fetchPromise = (0, node_fetch_1.default)(`http://${ip}/api?m=${token}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
            body: exports.STATUS_READ_BODY,
        });
        fetchPromise.catch(() => undefined);
        const res = await Promise.race([
            fetchPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (!res) {
            return null;
        }
        const json = await res.json().catch(() => null);
        if (json && json.r && typeof json.r === 'object' && json.r.indoorUnit) {
            return 'match';
        }
        if (json && json._api_error) {
            return 'kumo';
        }
        return null;
    }
    catch (_a) {
        return null;
    }
}
async function mapLimit(items, limit, fn) {
    let idx = 0;
    const run = async () => {
        while (idx < items.length) {
            await fn(items[idx++]);
        }
    };
    const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) {
        workers.push(run());
    }
    await Promise.all(workers);
}
async function discoverDeviceIps(log, candidateIps, creds, opts = {}) {
    var _a, _b;
    const concurrency = (_a = opts.concurrency) !== null && _a !== void 0 ? _a : 24;
    const timeoutMs = (_b = opts.timeoutMs) !== null && _b !== void 0 ? _b : 3500;
    const found = new Map();
    const remaining = new Set(creds.keys());
    await mapLimit(candidateIps, concurrency, async (ip) => {
        if (remaining.size === 0) {
            return;
        }
        for (const serial of [...remaining]) {
            const result = await probeIpForSerial(ip, creds.get(serial), timeoutMs);
            if (result === 'match') {
                found.set(serial, ip);
                remaining.delete(serial);
                log.info(`[LOCAL] Discovered ${serial} at ${ip}`);
                break;
            }
            if (result === null) {
                break;
            }
        }
    });
    if (remaining.size > 0) {
        log.warn(`[LOCAL] ${remaining.size} device(s) not found on the LAN (will use cloud): ${[...remaining].join(', ')}`);
    }
    return found;
}
exports.discoverDeviceIps = discoverDeviceIps;
