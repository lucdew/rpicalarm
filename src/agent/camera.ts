import { spawn, ChildProcess } from "child_process";
import * as _ from "lodash";
import * as log4js from "log4js";
import * as fs from "fs";
import * as tmp from "tmp";
import { ICameraSettings, IRecorder, ISessionInfo } from "../api";
import { ReadStream } from "fs";
import GrpcBackendClient from "../backendClient";
import * as grpc from "grpc";

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
  backendClient: GrpcBackendClient;
  cameraSettings: ICameraSettings;
  name = "camera";

  constructor(cameraSettings: ICameraSettings) {
    this.imageSavePath = cameraSettings.savePath || "/var/tmp/";
    this.cameraSettings = cameraSettings;
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath); // non recursive
    }
    this.backendClient = new GrpcBackendClient(this.imageSavePath);
    //process.on("SIGINT", this._killCameraProc.bind(this));
  }

  async startWarningRecording(sessionInfo: ISessionInfo) {
    await this._invoke("StartTimelapse", {});
  }

  get assetsSavePath() {
    return this.imageSavePath;
  }

  async takePhoto(): Promise<Buffer> {
    const res = await this._invoke("TakePicture", {});
    return res.picture;
  }

  async stopRecording() {
    await this._invoke("StopTimelapse", {});
  }

  async toggleWebCam(): Promise<boolean> {
    const res = await this._invoke("ToggleWebStream", {
      url: this.cameraSettings.youtubeUrl + "/" + this.cameraSettings.youtubeStreamKey
    });
    return res.isStreaming;
  }

  async getStatus(): Promise<string> {
    const res = await this._invoke("GetState", {});
    return res.state;
  }

  async _invoke(meth: string, args: any): Promise<any> {
    const client = await this.backendClient.getCameraClient();
    const res = await client[meth + "Async"].apply(client, [args]);
    if (!("result" in res)) {
      throw new Error("unexpected camera result");
    }
    if (!res.result.status) {
      throw new Error(res.result.message);
    }
    return res;
  }
}
