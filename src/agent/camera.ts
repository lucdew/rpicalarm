import * as _ from "lodash";
import * as log4js from "log4js";
import * as fs from "fs";
import { ICameraSettings, IRecorder, ISessionInfo, ISensor } from "../api";
import GrpcBackendClient from "../backendClient";
import Alarm from "../alarm";

const logger = log4js.getLogger("camera");

interface ImageDimensions {
  width: Number;
  height: Number;
}

export default class Camera implements IRecorder, ISensor {
  imageSavePath: string;
  imageSizeDims: ImageDimensions;
  backendClient: GrpcBackendClient;
  cameraSettings: ICameraSettings;
  name = "camera";
  subscriber: any;

  constructor(cameraSettings: ICameraSettings, public alarm: Alarm) {
    this.imageSavePath = cameraSettings.savePath || "/var/tmp/";
    this.cameraSettings = cameraSettings;
    if (!fs.existsSync(this.imageSavePath)) {
      fs.mkdirSync(this.imageSavePath); // non recursive
    }
    this.backendClient = new GrpcBackendClient(this.imageSavePath);
    //process.on("SIGINT", this._killCameraProc.bind(this));
  }

  async start(): Promise<any> {
    if (!this.subscriber) {
      const client = await this.backendClient.getCameraClient();
      this.subscriber = client.SubscribeNotifications({});
      this.subscriber.on("data", (data: any) => {
        logger.debug("Received camera notification %j", data);
        logger.info("Camera motion detected at %s", new Date());
        this.alarm.motionDetected();
      });
      this.subscriber.on("error", (err: Error) => {
        logger.error("Error communicating with camera", err);
      });
      this.subscriber.on("end", () => {
        this.subscriber = undefined;
      });
    }
    await this._invoke("StartMotionDetection", {});
  }

  async stop(): Promise<any> {
    if (this.subscriber) {
      this.subscriber.end();
    }
    await this._invoke("StopMotionDetection", {});
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
