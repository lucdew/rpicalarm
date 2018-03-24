import { spawn, ChildProcess } from "child_process";
import * as log4js from "log4js";
import * as fs from "fs";
import * as tmp from "tmp";
import { ICameraSettings, IRecorder, ISessionInfo } from "../api";
import { ReadStream } from "fs";
import PyBackendClient from "../pybackendclient";
// import Stream from "stream" // todo stream support

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

export default class Camera implements IRecorder {
  imageSavePath: string;
  imageSizeDims: ImageDimensions;
  pyBackendClient: PyBackendClient;
  cameraSettings: ICameraSettings;
  name = "camera";

  constructor(cameraSettings: ICameraSettings) {
    this.imageSavePath = cameraSettings.savePath || "/var/tmp/";
    const [width, height] = cameraSettings.imageSize.toLowerCase().split("x");
    this.imageSizeDims = {
      width: parseInt(width),
      height: parseInt(height)
    };
    this.cameraSettings = cameraSettings;
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath); // non recursive
    }
    this.pyBackendClient = new PyBackendClient(this.imageSavePath);
    //process.on("SIGINT", this._killCameraProc.bind(this));
  }

  async startWarningRecording(sessionInfo: ISessionInfo) {
    await this.pyBackendClient.request({
      cmd: "takeTimelapse",
      width: this.imageSizeDims.width,
      height: this.imageSizeDims.height,
      prefix: sessionInfo.sessionId,
      save_path: this.imageSavePath
    });
  }

  get assetsSavePath() {
    return this.imageSavePath;
  }

  async takePhoto(): Promise<Buffer> {
    return <Buffer>await this.pyBackendClient.request({
      cmd: "takePicture",
      width: this.imageSizeDims.width,
      height: this.imageSizeDims.height,
      v_flip: !!this.cameraSettings.vflip,
      h_flip: !!this.cameraSettings.hflip
    });
  }

  async stopRecording() {
    await this.pyBackendClient.request({
      cmd: "stopTimelapse"
    });
  }
}
