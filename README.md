Note: This plugin has forked from [ecoen66/homebridge-wave-plus](https://github.com/ecoen66/homebridge-wave-plus) but it was not work.
so, almost re-implemented to working completely.

# @kanreisa/homebridge-wave-plus

A Homebridge Plugin for Airthings Wave Plus. w/ InfluxDB v2 Support.

## Prerequisites

- [Homebridge](https://github.com/homebridge/homebridge) installed Bluetooth LE enabled computer.
  - tested: Raspberry Pi 3B+
- [Airthings Wave Plus](https://www.airthings.com/wave-plus)

## HomeKit Supported Sensors

Due to HomeKit limitations, the following sensors are currently enabled.

- Air Quality (w/ VOC)
- CO2
- Humidity
- Temp

## InfluxDB v2 Outputs

measurement: **air-quality**

| field | sensor | units | Comments |
|-------|--------|-------|----------|
| `rssi` | - | dBm | BLE received signal strength
| `humidity` | Humidity | %rH | 
| `temp` | Temperature | &deg;C |
| `radonStAvg` | Radon short term average | Bq/㎥ | First measurement available 1 hour after inserting batteries
| `radonLtAvg` | Radon long term average | Bq/㎥ | First measurement available 1 hour after inserting batteries
| `pressure` | Relative atmospheric pressure | hPa |
| `co2` | CO2 level | ppm |
| `voc` | TVOC level | ppb | Total volatile organic compounds level

sensor descriptions quoted from [Airthings/waveplus-reader](https://github.com/Airthings/waveplus-reader).

## Configuration

All configuration can set on UI.
