const gpio = require('rpi-gpio-mod')
const BbPromise = require('bluebird')

class PirSensor {
  constructor (cfg, {
    alarm
  }) {
    this.pinNum = cfg.pin_num
    this.alarm = alarm
    this.gpioListening = false
  }

  onChangeDetected (chan, val) {
    if (val === false) {
      return
    }
    const changeTime = Date.now()
    if (this.lastChangeTime && (changeTime - this.lastChangeTime < 15000)) {
      this.alarm.motionDetected()
    }
    this.lastChangeTime = changeTime
  }

  start () {
    return new BbPromise((res, rej) => {
      this.changeListener = this.onChangeDetected.bind(this)
      gpio.on('change', this.changeListener)
      if (this.gpioListening === true) {
        res()
      } else {
        gpio.setup(this.pinNum, gpio.DIR_IN, gpio.EDGE_BOTH, err => {
          if (err) {
            return rej(err)
          }
          this.gpioListening = true
          return res()
        })
      }
    })
  }

  stop () {
    gpio.removeListener('change', this.changeListener)
    // Not destroying to see if it fixes issues of receiving abnormal motion detection changes callbacks
    // gpio.destroy()
    return BbPromise.resolve()
  }
}

PirSensor.$inject = ['alarm']
PirSensor.supports = ['sensor']
module.exports = PirSensor
