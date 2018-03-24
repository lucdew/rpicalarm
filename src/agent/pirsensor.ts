import Alarm from "../alarm";
import { ISensor } from "../api";

const gpio = require("rpi-gpio-mod");

export default class PirSensor implements ISensor {
  name = "pirSensor";
  private gpioListening = false;
  private lastChangeTime: number;
  private changeListener: (chan: string, val: boolean) => void;

  constructor(public pinNum: number, public alarm: Alarm) {}

  onChangeDetected(chan: string, val: boolean) {
    if (val === false) {
      return;
    }
    const changeTime = Date.now();
    if (this.lastChangeTime && changeTime - this.lastChangeTime < 15000) {
      this.alarm.motionDetected();
    }
    this.lastChangeTime = changeTime;
  }

  async start() {
    await this._doStart();
  }

  _doStart(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.changeListener = this.onChangeDetected.bind(this);
      gpio.on("change", this.changeListener);
      if (this.gpioListening === true) {
        return resolve();
      }
      gpio.setup(this.pinNum, gpio.DIR_IN, gpio.EDGE_BOTH, (err: Error) => {
        if (err) {
          return reject(err);
        }
        this.gpioListening = true;
        return resolve();
      });
    });
  }

  async stop() {
    gpio.removeListener("change", this.changeListener);
    // Not destroying to see if it fixes issues of receiving abnormal motion detection changes callbacks
    // gpio.destroy()
    return Promise.resolve();
  }
}
