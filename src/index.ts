import { API, AccessoryPlugin, Logger, AccessoryConfig, Service, Characteristic } from "homebridge";
import { InfluxDB, WriteApi, Point, HttpError } from "@influxdata/influxdb-client";
import noble = require("noble");
import struct = require("python-struct");
import Queue = require("promise-queue");

export = (api: API) => {
    api.registerAccessory("homebridge-wave-plus", "Homebridge Wave Plus", HomebridgeWavePlusPlugin);
};

const characteristicUUIDs = ["b42e2a68ade711e489d3123b93f75cba"];
const globalQueue = new Queue(1, Infinity);

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

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
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

        this.api.on("didFinishLaunching", async () => {
            this.log.debug("Executed didFinishLaunching callback");
            await sleep(1000 * 5);
            globalQueue.add(async () => await this.main());
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
            this._mainTimer = setTimeout(() => {
                globalQueue.add(async () => await this.main())
            }, 1000 * 10);
            return;
        }

        if (!this._peripheral) {
            if (this._scanning === true) {
                return;
            }
            globalQueue.add(async () => {
                await this.scan();
                await this.main();
            });
            return;
        }

        const freq = 1000 * Math.max(60, this.config.frequency);
        this._mainTimer = setTimeout(() => {
            globalQueue.add(async () => await this.main());
        }, freq);

        const peri = this._peripheral;

        if (peri.state !== "disconnected") {
            this.log.warn(`Peripheral state is "${peri.state}".`);

            if (peri.state === "connected") {
                await peri.disconnectAsync();
            } else if (peri.state === "connecting") {
                peri.cancelConnect();
            } else if (peri.state === "error") {
                this._peripheral = undefined;
                await sleep(1000 * 3);
                globalQueue.add(async () => await this.scan());
                try {
                    peri.cancelConnect();
                    peri.disconnectAsync();
                } catch (e) {
                    this.log.error(e);
                }
                return;
            }
        }

        this.log.info("connect to", this.config.serialNumber, "...");

        const disconnect = async () => {
            await Promise.race([
                sleep(1000 * 5),
                (async () => {
                    try {
                        await peri.disconnectAsync();
                    } catch (e) {
                        this.log.error(e);
                    }
                })()
            ]);
        };

        {
            let done = false;
            await Promise.race([
                (async () => {
                    await sleep(1000 * 3);
                    if (done === false) {
                        this.log.warn("connect has timed out.");
                        try {
                            peri.cancelConnect();
                        } catch (e) {
                            this.log.error(e);
                        }
                    }
                })(),
                (async () => {
                    // connect
                    try {
                        await peri.connectAsync();
                        done = true;
                    } catch (e) {
                        this.log.error(e);
                        await disconnect();
                    }
                })()
            ]);

            if (done === false) {
                await sleep(1000 * 3);
                globalQueue.add(async () => await this.main());
                return;
            }
        }

        let buf: Buffer;
        await Promise.race([
            (async () => {
                await sleep(1000 * 3);
                if (!buf) {
                    this.log.warn("get collection has timed out.");
                    await disconnect();
                }
            })(),
            (async () => {
                peri.updateRssi();
                const char = await peri.discoverSomeServicesAndCharacteristicsAsync([], characteristicUUIDs);
                buf = await char.characteristics[0].readAsync();
                await disconnect();
            })()
        ]);

        if (!buf) {
            await sleep(1000 * 3);
            globalQueue.add(async () => await this.main());
            return;
        }

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

        if (co2 === 0xFFFF || voc === 0xFFFF) {
            this.log.warn("sensor value is invalid.");
            return;
        }

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
                if (co2 >= 1500) {
                    aq = Math.max(aq, 5);
                } else if (co2 >= 1200) {
                    aq = Math.max(aq, 4);
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

            try {
                this._influx.writePoint(point);
                await this._influx.flush();
            } catch (e) {
                this.log.error(e);
            }

            this.log.debug("point:", point);
        }

        await sleep(1000 * 3);
    }

    scan(): Promise<void> {
        return new Promise(resolve => {

            if (this._scanning === true) {
                return;
            }
            this._scanning = true;

            this.log.info("scanning...");

            const fin = () => {
                this._scanning = false;
                clearTimeout(timeout);
                noble.stopScanning();
                noble.removeListener("discover", onDiscover);
                setTimeout(resolve, 1000 * 3);
            };
            const timeout = setTimeout(() => {
                this.log.warn("scan has timed out.")
                fin();
            }, 1000 * 50);

            const onDiscover = (peripheral: noble.Peripheral) => {
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
                            fin();
                        }
                    }
                }
            };
            noble.on("discover", onDiscover);

            noble.startScanningAsync([], true);
        });
    }
}
