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
exports.saveCredStore = exports.loadCredStore = void 0;
const fs = __importStar(require("fs"));
function loadCredStore(file, log) {
    var _a;
    const out = new Map();
    try {
        if (!fs.existsSync(file)) {
            return out;
        }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [serial, v] of Object.entries(((_a = data === null || data === void 0 ? void 0 : data.devices) !== null && _a !== void 0 ? _a : {}))) {
            const c = v;
            if (typeof c.password === 'string' && typeof c.cryptoSerial === 'string') {
                out.set(serial, {
                    password: c.password,
                    cryptoSerial: c.cryptoSerial,
                    capturedAt: typeof c.capturedAt === 'string' ? c.capturedAt : new Date().toISOString(),
                });
            }
        }
        log.debug(`Local credential store: loaded ${out.size} device(s)`);
    }
    catch (e) {
        log.warn(`Local credential store unreadable (${e instanceof Error ? e.message : String(e)}) — starting empty`);
    }
    return out;
}
exports.loadCredStore = loadCredStore;
function saveCredStore(file, creds, log) {
    try {
        const devices = {};
        for (const [serial, c] of creds) {
            devices[serial] = c;
        }
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    catch (e) {
        log.warn(`Local credential store write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
exports.saveCredStore = saveCredStore;
