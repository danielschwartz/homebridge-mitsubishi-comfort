import type { Logger } from 'homebridge';
import { SerialCreds } from './local-api';
interface StoredCred extends SerialCreds {
    capturedAt: string;
}
export declare function loadCredStore(file: string, log: Logger): Map<string, StoredCred>;
export declare function saveCredStore(file: string, creds: Map<string, StoredCred>, log: Logger): void;
export {};
