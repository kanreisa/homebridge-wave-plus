import { API, AccessoryPlugin, Logger, AccessoryConfig, Service, Characteristic } from "homebridge";
import { InfluxDB, WriteApi, Point, HttpError } from "@influxdata/influxdb-client";
import noble = require("noble");
import struct = require("python-struct");

export = (api: API) => {
    api.registerAccessory("homebridge-wave-plus", "Homebridge Wave Plus", HomebridgeWavePlusPlugin);
};

const characteristicUUIDs = ["b42e2a68ade711e489d3123b93f75cba"];

interface Config extends AccessoryConfig {
    serialNumber?: string;
    frequency?: number;
    disableAQ?: boolean;
    disableCO2?: boolean;
    disableHumidity?: boolean;
    disableTemp?: boolean;
    influxURL?: string;
    influxToken?: string;
    influxOrg?: string;
    influxBucket?: string;
}

class HomebridgeWavePlusPlugin implements AccessoryPlugin {

    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    private readonly manufacturer = "Airthings";
    private readonly model = "Wave Plus";

    private _aqService: Service | void;
    private _co2Service: Service | void;
    private _humidityService: Service | void;
    private _tempService: Service | void;

    private _lastState = {
        aq: -1,
        voc: -1,
        co2: -1,
        humidity: -1,
        temp: -1
    };

    private _mainTimer: NodeJS.Timer | void;
    private _scanning: boolean = false;
    private _peripheral: noble.Peripheral | void;

    private _influx: WriteApi | void;

    constructor(
        public readonly log: Logger,
        public readonly config: Config,
        public readonly api: API
    ) {
        // Sensors
        if (!this.config.disableAQ) {
            this._aqService = new this.Service.AirQualitySensor(this.config.name);
        }
        if (!this.config.disableCO2) {
            this._co2Service = new this.Service.CarbonDioxideSensor(this.config.name);
            this._co2Service
                .getCharacteristic(this.Characteristic.CarbonDioxideLevel)
                .setProps({ minValue: 0, maxValue: 100000, minStep: 1 });
        }
        if (!this.config.disableHumidity) {
            this._humidityService = new this.Service.HumiditySensor(this.config.name);
            this._humidityService
                .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
                .setProps({ minValue: 0, maxValue: 100, minStep: 0.5 });
        }
        if (!this.config.disableTemp) {
            this._tempService = new this.Service.TemperatureSensor(this.config.name);
            this._tempService
                .getCharacteristic(this.Characteristic.CurrentTemperature)
                .setProps({ minValue: -200, maxValue: 200, minStep: 0.01 });
        }

        // InfluxDB Support
        if (this.config.influxURL && this.config.influxToken && this.config.influxOrg && this.config.influxBucket) {
            this._influx = new InfluxDB({
                url: this.config.influxURL,
                token: this.config.influxToken
            }).getWriteApi(this.config.influxOrg, this.config.influxBucket, "s");
            // identity
            this._influx.useDefaultTags({
                name: this.config.name,
                serialNumber: this.config.serialNumber
            });
        }

        noble.on("warning", warning => {
            this.log.warn(warning);
        });

        this.api.on("didFinishLaunching", () => {
            this.log.debug("Executed didFinishLaunching callback");
            setTimeout(() => this.main(), 1000 * 10);
        });

        this.log.info("Finished initializing accessory:", this.config.name);
    }

    getServices() {
        const informationService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(this.Characteristic.Model, this.model)
            .setCharacteristic(this.Characteristic.SerialNumber, this.config.serialNumber);

        const services = [informationService];

        if (this._aqService) {
            services.push(this._aqService);
        }
        if (this._co2Service) {
            services.push(this._co2Service);
        }
        if (this._humidityService) {
            services.push(this._humidityService);
        }
        if (this._tempService) {
            services.push(this._tempService);
        }

        return services;
    }

    async main() {

        if (this._mainTimer) {
            clearTimeout(this._mainTimer);
        }

        if (noble.state !== 'poweredOn') {
            this.log.warn("Bluetooth LE Power is off. will retry in 10 seconds...");
            this._mainTimer = setTimeout(() => this.main(), 1000 * 10);
            return;
        }

        this._mainTimer = setTimeout(() => this.main(), 1000 * Math.max(60, this.config.frequency));

        if (!this._peripheral) {
            if (this._scanning === true) {
                return;
            }
            this.scan();
            return;
        }

        const peri = this._peripheral;

        this.log.info("connect to", this.config.serialNumber, "...");

        if (peri.state !== "disconnected") {
            this.log.warn(`Peripheral state is "${peri.state}".`);

            if (peri.state === "connected") {
                await peri.disconnectAsync();
            } else if (peri.state === "connecting") {
                peri.cancelConnect();
            } else if (peri.state === "error") {
                try {
                    peri.cancelConnect();
                    await peri.disconnectAsync();
                } catch (e) {
                    this.log.error(e);
                }
                this._peripheral = undefined;
                this.scan();
                return;
            }
        }

        const timeout = setTimeout(() => {
            this.log.warn("connect has timed out.");
            try {
                peri.cancelConnect();
            } catch (e) {
                this.log.error(e);
            }
        }, 1000 * 50);

        // connect
        try {
            await peri.connectAsync();
        } catch (e) {
            try {
                await peri.disconnectAsync();
            } catch (e) {
                this.log.error(e);
            }
            this.log.error(e);
            return;
        }

        await peri.updateRssiAsync();
        const char = await peri.discoverSomeServicesAndCharacteristicsAsync([], characteristicUUIDs);
        const buf = await char.characteristics[0].readAsync();
        const data = struct.unpack('BBBBHHHHHHHH', buf) as number[];

        // note: https://github.com/Airthings/waveplus-reader
        const humidity = data[1] / 2.0;
        const radonStAvg = data[4];
        const radonLtAvg = data[5];
        const temp = data[6] / 100.0;
        const pressure = data[7] / 50.0;
        const co2 = data[8] * 1.0;
        const voc = data[9] * 1.0;

        this.log.info("rssi", peri.rssi, "data", JSON.stringify({
            humidity,
            radonStAvg,
            radonLtAvg,
            temp,
            pressure,
            co2,
            voc
        }));
        
        // for Homebridge / HomeKit
        {
            if (this._aqService) {
                // note: https://github.com/homebridge/HAP-NodeJS/blob/c6f162279d3a5ad13b6f13f13da1ed83bd9074d2/src/lib/definitions/CharacteristicDefinitions.ts#L186
                let aq = 0;
                if (humidity >= 70 || humidity < 25) {
                    aq = 5;
                } else if (humidity >= 60 || humidity < 30) {
                    aq = 3;
                } else {
                    aq = 2;
                }
                if (radonStAvg >= 150) {
                    aq = Math.max(aq, 5);
                } else if (radonStAvg >= 100) {
                    aq = Math.max(aq, 3);
                } else {
                    aq = Math.max(aq, 2);
                }
                if (co2 >= 1000) {
                    aq = Math.max(aq, 5);
                } else if (co2 >= 800) {
                    aq = Math.max(aq, 3);
                } else {
                    aq = Math.max(aq, 2);
                }
                if (voc >= 2000) {
                    aq = Math.max(aq, 5);
                } else if (voc >= 250) {
                    aq = Math.max(aq, 3);
                } else {
                    aq = Math.max(aq, 2);
                }
                if (aq !== this._lastState.aq || voc !== this._lastState.voc) {
                    this._lastState.aq = aq;
                    this._lastState.voc = voc;
                    this._aqService
                        .getCharacteristic(this.Characteristic.AirQuality)
                        .updateValue(aq);
                    this._aqService
                        .getCharacteristic(this.Characteristic.VOCDensity)
                        .updateValue(voc);
                    
                }
            }
            if (this._co2Service) {
                if (co2 !== this._lastState.co2) {
                    this._lastState.co2 = co2;
                    this._co2Service
                        .getCharacteristic(this.Characteristic.CarbonDioxideLevel)
                        .updateValue(co2);
                }
            }
            if (this._humidityService) {
                if (humidity !== this._lastState.humidity) {
                    this._lastState.humidity = humidity;
                    this._humidityService
                        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
                        .updateValue(humidity);
                }
            }
            if (this._tempService) {
                if (temp !== this._lastState.temp) {
                    this._lastState.temp = temp;
                    this._tempService
                        .getCharacteristic(this.Characteristic.CurrentTemperature)
                        .updateValue(temp);
                }
            }
        }

        clearTimeout(timeout);

        // disconnect
        try {
            await peri.disconnectAsync();
        } catch (e) {
            this.log.error(e);
            return;
        }

        // for InfluxDB
        if (this._influx) {
            this.log.info("write points to InfluxDB");

            const point = new Point("air-quality")
                .floatField("rssi", peri.rssi)
                .floatField("humidity", humidity)
                .floatField("radonStAvg", radonStAvg)
                .floatField("radonLtAvg", radonLtAvg)
                .floatField("temp", temp)
                .floatField("pressure", pressure)
                .floatField("co2", co2)
                .floatField("voc", voc);
            
            this._influx.writePoint(point);
            await this._influx.flush();

            this.log.debug("point:", point);
        }
    }

    async scan() {

        if (this._scanning === true) {
            return;
        }
        this._scanning = true;

        this.log.info("scanning...");
        
        const fin = async () => {
            this._scanning = false;
            clearTimeout(timeout);
            noble.stopScanning();
            noble.removeListener("discover", onDiscover);
        };
        const timeout = setTimeout(() => {
            this.log.warn("scan has timed out.")
            fin();
        }, 1000 * 50);

        const onDiscover = async (peripheral: noble.Peripheral) => {
            const manufacturerData = peripheral.advertisement ? peripheral.advertisement.manufacturerData : undefined;
            if (manufacturerData && manufacturerData.length > 6) {
                const deviceInfo = struct.unpack("<HLH", manufacturerData) as number[];
                // find Wave Plus
                if (deviceInfo[0] === 0x0334) {
                    const serialNumber = deviceInfo[1];
                    // find serialNumber
                    if (parseInt(this.config.serialNumber, 10) === serialNumber) {
                        // found
                        this.log.info(`found: ${serialNumber} (rssi=${peripheral.rssi})`);
                        this._peripheral = peripheral;
                        await fin();
                        this.main();
                    }
                }
            }
        };
        noble.on("discover", onDiscover);

        await noble.startScanningAsync([], true);
    }
}
