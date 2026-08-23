"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signature = exports.toMirrorState = exports.MirrorController = void 0;
const DEFAULT_DEBOUNCE_MS = 1000;
class MirrorController {
    constructor(log, pairs, handlers, debounceMs = DEFAULT_DEBOUNCE_MS) {
        this.log = log;
        this.debounceMs = debounceMs;
        this.watches = new Map();
        const bySerial = new Map(handlers.map(h => [h.getDeviceSerial(), h]));
        for (const pair of pairs) {
            if (pair.source === pair.target) {
                this.log.warn(`[MIRROR] source === target (${pair.source}) — skipping`);
                continue;
            }
            const source = bySerial.get(pair.source);
            const target = bySerial.get(pair.target);
            if (!source) {
                this.log.warn(`[MIRROR] source device ${pair.source} not found — skipping`);
                continue;
            }
            if (!target) {
                this.log.warn(`[MIRROR] target device ${pair.target} not found — skipping`);
                continue;
            }
            let watch = this.watches.get(pair.source);
            if (!watch) {
                watch = { targets: [], lastSignature: null, latest: null, timer: null };
                this.watches.set(pair.source, watch);
                source.onStatusUpdate(status => this.onSourceUpdate(pair.source, status));
            }
            watch.targets.push(target);
            this.log.info(`[MIRROR] ${target.getDeviceSerial()} will follow ${pair.source}`);
        }
    }
    onSourceUpdate(sourceSerial, status) {
        const watch = this.watches.get(sourceSerial);
        if (!watch) {
            return;
        }
        const state = toMirrorState(status);
        watch.latest = state;
        const sig = signature(state);
        if (watch.lastSignature === null) {
            watch.lastSignature = sig;
            this.log.debug(`[MIRROR] ${sourceSerial}: baseline seeded (${sig})`);
            return;
        }
        if (sig === watch.lastSignature) {
            return;
        }
        watch.lastSignature = sig;
        if (watch.timer) {
            clearTimeout(watch.timer);
        }
        watch.timer = setTimeout(() => {
            watch.timer = null;
            this.dispatch(sourceSerial);
        }, this.debounceMs);
    }
    dispatch(sourceSerial) {
        const watch = this.watches.get(sourceSerial);
        if (!watch || !watch.latest) {
            return;
        }
        const desired = watch.latest;
        for (const target of watch.targets) {
            target.applyMirror(desired).catch(err => this.log.error(`[MIRROR] ${target.getDeviceSerial()} apply failed: ${err.message}`));
        }
    }
    destroy() {
        for (const watch of this.watches.values()) {
            if (watch.timer) {
                clearTimeout(watch.timer);
                watch.timer = null;
            }
        }
    }
}
exports.MirrorController = MirrorController;
function toMirrorState(s) {
    return {
        operationMode: s.operationMode,
        power: s.power,
        spHeat: s.spHeat,
        spCool: s.spCool,
        fanSpeed: s.fanSpeed,
    };
}
exports.toMirrorState = toMirrorState;
function signature(s) {
    if (s.power === 0 || s.operationMode === 'off') {
        return 'off';
    }
    const mode = s.operationMode.startsWith('auto') ? 'auto' : s.operationMode;
    const r = (n) => (typeof n === 'number' && !isNaN(n) ? Math.round(n * 10) / 10 : 'x');
    const fan = s.fanSpeed || '';
    switch (mode) {
        case 'heat':
            return `heat|${r(s.spHeat)}|${fan}`;
        case 'cool':
            return `cool|${r(s.spCool)}|${fan}`;
        case 'auto':
            return `auto|${r(s.spHeat)}|${r(s.spCool)}|${fan}`;
        case 'dry':
            return `dry|${r(s.spCool)}|${fan}`;
        case 'vent':
            return `vent|${fan}`;
        default:
            return `${mode}|${r(s.spHeat)}|${r(s.spCool)}|${fan}`;
    }
}
exports.signature = signature;
