import type { Logger } from 'homebridge';
import { MirrorPair, MirrorState, DeviceStatus } from './settings';
import type { KumoThermostatAccessory } from './accessory';
export declare class MirrorController {
    private readonly log;
    private readonly debounceMs;
    private readonly watches;
    constructor(log: Logger, pairs: MirrorPair[], handlers: KumoThermostatAccessory[], debounceMs?: number);
    private onSourceUpdate;
    private dispatch;
    destroy(): void;
}
export declare function toMirrorState(s: DeviceStatus): MirrorState;
export declare function signature(s: MirrorState): string;
