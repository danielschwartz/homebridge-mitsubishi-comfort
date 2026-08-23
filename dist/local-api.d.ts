/// <reference types="node" />
import { Logger } from 'homebridge';
import { Commands, DeviceStatus } from './settings';
export declare const STATUS_READ_BODY: Buffer;
export interface LocalDeviceCreds {
    ip: string;
    password: string;
    cryptoSerial: string;
}
export declare function computeLocalToken(passwordB64: string, cryptoSerialHex: string, body: Buffer): string;
export declare function buildLocalCommandBody(commands: Commands): Buffer;
export declare function mapLocalStatus(local: Record<string, unknown>): Partial<DeviceStatus>;
export declare class LocalKumoClient {
    private readonly log;
    private readonly timeoutMs;
    private readonly creds;
    private readonly chains;
    constructor(log: Logger, timeoutMs?: number);
    setCreds(serial: string, creds: LocalDeviceCreds): void;
    clearCreds(serial: string): void;
    hasLocal(serial: string): boolean;
    getIp(serial: string): string | undefined;
    private withLock;
    request(serial: string, body: Buffer): Promise<Record<string, unknown> | null>;
    getStatus(serial: string): Promise<Partial<DeviceStatus> | null>;
    sendCommand(serial: string, commands: Commands): Promise<boolean>;
}
export interface SerialCreds {
    password: string;
    cryptoSerial: string;
}
export declare function enumerateSubnet(hostIpv4: string): string[];
export declare function discoverDeviceIps(log: Logger, candidateIps: string[], creds: Map<string, SerialCreds>, opts?: {
    concurrency?: number;
    timeoutMs?: number;
}): Promise<Map<string, string>>;
