const spawn = require('child_process').spawn
const log4js = require('log4js')
const fs = require('fs')
const logger = log4js.getLogger('camera')
const BbPromise = require('bluebird')
const tmp = require('tmp')

class Camera {
  constructor ({
    save_path: imageSavePath,
    image_size: imageSize
  }) {
    this.imageSavePath = imageSavePath || '/var/tmp/'
    const [width, height] = imageSize.toLowerCase().split('x')
    this.imageSizeDims = {
      width,
      height
    }
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath) // non recursive
    }
    process.on('SIGINT', this._killCameraProc.bind(this))
  }

  startWarningRecording ({
    sessionId
  }) {
    return this._takePhoto({
      timeout: 3600000,
      timelapse: 10000,
      prefix: sessionId
    })
  }

  get assetsSavePath () {
    return this.imageSavePath
  }

  takePhoto () {
    return this._takePhoto({
      timeout: 1500
    })
  }

  _killCameraProc () {
    if (this.cameraProc) {
      this.cameraProc.kill()
      this.cameraProc = null
    }
  }

  _takePhoto ({
    width = this.imageSizeDims.width,
    height = this.imageSizeDims.width,
    savePath = this.imageSavePath,
    timeout,
    timelapse,
    quality = 60,
    prefix = 'rpicalarm'
  }) {
    // TODO: handle case where cameraProc is running

    return new BbPromise((res, rej) => {
      let varOpts = !isNaN(timeout) ? ` --timeout ${timeout}` : ''
      let saveFile
      if (timelapse) {
        varOpts += ` --timelapse ${timelapse} -o ${savePath}/${prefix}_%d.jpg --timestamp`
      } else {
        saveFile = tmp.tmpNameSync({
          prefix,
          postfix: '.jpg'
        })
        varOpts += ` -o ${saveFile}`
      }
      const cmd = `raspistill -w ${width} -h ${height} --vflip --quality ${quality}${varOpts}`
      const [prg, ...prgArgs] = cmd.split(' ')
      logger.debug('Executing %s', cmd)
      this.cameraProc = spawn(prg, prgArgs, {
        cwd: this.imageSavePath,
        detached: false,
        stdio: 'inherit'
      })
      this.cameraProc.on('error', err => {
        this.cameraProc = null
        return rej(err)
      })
      this.cameraProc.on('exit', (code, signal) => {
        this.cameraProc = null
        if (timelapse) {
          return
        }
        if (signal) {
          return rej(`Photo process raspistill received ${signal}`)
        }
        return res(saveFile)
      })
      if (timelapse) { // do not wait for proc completion
        return res(savePath)
      }
    })
  }

  stopRecording () {
    this._killCameraProc()
    return BbPromise.resolve()
  }

}

Camera.supports = ['recording']

module.exports = Camera
