export declare const PLATFORM_NAME = "KumoV3";
export declare const PLUGIN_NAME = "homebridge-mitsubishi-comfort";
export declare const API_BASE_URL = "https://app-prod.kumocloud.com/v3";
export declare const SOCKET_BASE_URL = "https://socket-prod.kumocloud.com";
export declare const LEGACY_API_BASE_URL = "https://geo-c.kumocloud.com";
export declare const LEGACY_APP_VERSION = "2.2.0";
export declare const TOKEN_REFRESH_INTERVAL: number;
export declare const POLL_INTERVAL: number;
export declare const APP_VERSION = "3.2.4";
export interface KumoConfig {
    platform: string;
    name?: string;
    username: string;
    password: string;
    pollInterval?: number;
    disablePolling?: boolean;
    debug?: boolean;
    excludeDevices?: string[];
    streamingHealthCheckInterval?: number;
    streamingStaleThreshold?: number;
    degradedPollInterval?: number;
    localControl?: boolean;
    localControlIps?: Record<string, string>;
    localPollInterval?: number;
    mirror?: MirrorPair[];
    temperatureUnit?: 'F' | 'C';
    enableHistory?: boolean;
}
export interface MirrorPair {
    source: string;
    target: string;
}
export interface MirrorState {
    operationMode: string;
    power: number;
    spHeat: number;
    spCool: number;
    fanSpeed: string;
}
export interface LoginResponse {
    id: string;
    username: string;
    email: string;
    token: {
        access: string;
        refresh: string;
    };
    preferences?: Record<string, unknown>;
}
export interface Site {
    id: string;
    name: string;
}
export interface Zone {
    id: string;
    name: string;
    isActive: boolean;
    adapter: Adapter;
}
export interface Adapter {
    id: string;
    deviceSerial: string;
    roomTemp: number;
    spHeat: number;
    spCool: number;
    spAuto: number | null;
    humidity: number | null;
    power: number;
    operationMode: string;
    previousOperationMode: string;
    fanSpeed: string;
    airDirection: string;
    connected: boolean;
    isSimulator: boolean;
    hasSensor: boolean;
    hasMhk2: boolean;
    scheduleOwner: string;
    scheduleHoldEndTime: number;
    rssi?: number;
}
export interface DeviceStatus {
    id: string;
    deviceSerial: string;
    rssi: number;
    power: number;
    operationMode: string;
    humidity: number | null;
    fanSpeed: string;
    airDirection: string;
    roomTemp: number;
    spCool: number;
    spHeat: number;
    spAuto: number | null;
    modelNumber?: string;
    connected?: boolean;
    standby?: boolean;
    defrost?: boolean;
    filterDirty?: boolean;
}
export interface DeviceProfile {
    numberOfFanSpeeds: number;
    hasFanSpeedAuto: boolean;
    hasModeDry: boolean;
    usesSetPointInDryMode: boolean;
    hasModeHeat: boolean;
    hasModeVent: boolean;
    hasVaneDir: boolean;
    hasVaneSwing: boolean;
    hasDefrost: boolean;
    hasStandby: boolean;
    minimumSetPoints: {
        cool: number;
        heat: number;
        auto: number;
    };
    maximumSetPoints: {
        cool: number;
        heat: number;
        auto: number;
    };
}
export interface Commands {
    spHeat?: number;
    spCool?: number;
    operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
    fanSpeed?: 'auto' | 'low' | 'medium' | 'high';
    fanSpeedRaw?: string;
    power?: 0 | 1;
}
export interface SendCommandRequest {
    deviceSerial: string;
    commands: Commands;
}
export interface SendCommandResponse {
    devices: string[];
}
