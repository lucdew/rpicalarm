import { spawn, ChildProcess } from "child_process";
import * as api from "../api";
import * as log4js from "log4js";
import * as fs from "fs";
import * as tmp from "tmp";
import { ICameraSettings } from "../api";

const logger = log4js.getLogger("camera");

interface ImageDimensions {
  width: Number;
  height: Number;
}

interface TakePhotoSettings {
  width?: number;
  height?: number;
  savePath?: string;
  timeout: number;
  timelapse?: number;
  quality?: string;
  prefix?: string;
}

export default class Camera implements api.IRecorder {
  imageSavePath: string;
  imageSizeDims: ImageDimensions;
  cameraProc: ChildProcess;
  name = "camera";

  constructor(cameraSettings: ICameraSettings) {
    this.imageSavePath = cameraSettings.savePath || "/var/tmp/";
    const [width, height] = cameraSettings.imageSize.toLowerCase().split("x");
    this.imageSizeDims = {
      width: parseInt(width),
      height: parseInt(height)
    };
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath); // non recursive
    }
    process.on("SIGINT", this._killCameraProc.bind(this));
  }

  async startWarningRecording(sessionInfo: api.ISessionInfo) {
    return await this._takePhoto({
      timeout: 3600000,
      timelapse: 10000,
      prefix: sessionInfo.sessionId
    });
  }

  get assetsSavePath() {
    return this.imageSavePath;
  }

  async takePhoto() {
    return await this._takePhoto({
      timeout: 1500
    });
  }

  _killCameraProc() {
    if (this.cameraProc) {
      this.cameraProc.kill();
      this.cameraProc = null;
    }
  }

  _takePhoto({
    width = this.imageSizeDims.width,
    height = this.imageSizeDims.width,
    savePath = this.imageSavePath,
    timeout,
    timelapse = 0,
    quality = 60,
    prefix = "rpicalarm"
  }: TakePhotoSettings): Promise<any> {
    // TODO: handle case where cameraProc is running

    return new Promise((res, rej) => {
      let varOpts = !isNaN(timeout) ? ` --timeout ${timeout}` : "";
      let saveFile: string;
      if (timelapse > 0) {
        varOpts += ` --timelapse ${timelapse} -o ${savePath}/${prefix}_%d.jpg --timestamp`;
      } else {
        saveFile = tmp.tmpNameSync({
          prefix,
          postfix: ".jpg"
        });
        varOpts += ` -o ${saveFile}`;
      }
      const cmd = `raspistill -w ${width} -h ${height} --vflip --quality ${quality}${varOpts}`;
      const [prg, ...prgArgs] = cmd.split(" ");
      logger.debug("Executing %s", cmd);
      this.cameraProc = spawn(prg, prgArgs, {
        cwd: this.imageSavePath,
        detached: false,
        stdio: "inherit"
      });
      this.cameraProc.on("error", err => {
        this.cameraProc = null;
        return rej(err);
      });
      this.cameraProc.on("exit", (code, signal) => {
        this.cameraProc = null;
        if (timelapse) {
          return;
        }
        if (signal) {
          return rej(`Photo process raspistill received ${signal}`);
        }
        return res(saveFile);
      });
      if (timelapse) {
        // do not wait for proc completion
        return res(savePath);
      }
    });
  }

  async stopRecording() {
    this._killCameraProc();
    return Promise.resolve();
  }
}
