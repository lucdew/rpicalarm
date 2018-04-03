import { spawn, ChildProcess } from "child_process";
import * as _ from "lodash";
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
    this.cameraSettings = cameraSettings;
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath); // non recursive
    }
    this.pyBackendClient = new PyBackendClient(this.imageSavePath);
    //process.on("SIGINT", this._killCameraProc.bind(this));
  }

  async startWarningRecording(sessionInfo: ISessionInfo) {
    await this.pyBackendClient.request({
      target: "camera",
      cmd: "take_timelapse",
      prefix: sessionInfo.sessionId // TODO see usage of prefix
    });
  }

  get assetsSavePath() {
    return this.imageSavePath;
  }

  async takePhoto(): Promise<Buffer> {
    return <Buffer>await this.pyBackendClient.request({
      target: "camera",
      cmd: "take_picture"
    });
  }

  async stopRecording() {
    await this.pyBackendClient.request({
      target: "camera",
      cmd: "stop_bg_task"
    });
  }

  async toggleWebCam(): Promise<boolean> {
    const res = <Buffer>await this.pyBackendClient.request({
      target: "camera",
      cmd: "toggle_stream",
      url: this.cameraSettings.youtubeUrl + "/" + this.cameraSettings.youtubeStreamKey
    });
    return res.toString("utf-8").toLowerCase() === "true";
  }

  async getStatus(): Promise<string> {
    const res = <Buffer>await this.pyBackendClient.request({
      target: "camera",
      cmd: "get_state"
    });
    return res.toString("utf-8");
  }
}
