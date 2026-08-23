export declare const CELSIUS_TO_KUMO_FAHRENHEIT: Readonly<Record<string, number>>;
export declare const KUMO_SET_TEMP_FAHRENHEIT_TO_CELSIUS: Readonly<Record<number, number>>;
export declare function kumoFahrenheit(celsius: number): number;
export declare function celsiusForHomeKit(fahrenheit: number): number;
export declare function toHomeKitCelsius(celsius: number): number;
export declare function toKumoCelsius(homeKitCelsius: number): number;
