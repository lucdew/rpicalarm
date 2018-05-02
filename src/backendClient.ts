import { spawn, ChildProcess } from "child_process";
import * as log4js from "log4js";
import * as net from "net";
import * as path from "path";
import * as grpc from "grpc";
import * as util from "util";

const logger = log4js.getLogger("grpcBackendClient");

export default class GrpcBackendClient {
  pythonBackendProc: ChildProcess;
  cameraClient: any;

  public constructor(public cwd: string) {}

  private async connect(): Promise<void> {
    if (this.pythonBackendProc) {
      return;
    }
    const cmd = `python3 ${path.resolve(__dirname)}/backendserver-cli.py -v True -c ${
      process.env["CFG_FILE"]
    }`;
    const [prg, ...prgArgs] = cmd.split(" ");
    logger.debug("Executing %s", cmd);

    return new Promise<void>((resolve, reject) => {
      this.pythonBackendProc = spawn(prg, prgArgs, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.pythonBackendProc.stdout.on("data", (data: Buffer) => {
        process.stdout.write(data);
        if (data.toString().includes("server started")) {
          logger.debug("pybackend started");
          resolve();
        }
      });
      this.pythonBackendProc.on("exit", () => {
        logger.debug("python backend died");
        this.pythonBackendProc = undefined;
      });
    });
  }

  public async getCameraClient(): Promise<any> {
    if (this.cameraClient) {
      return this.cameraClient;
    }
    await this.connect();
    const backend_proto: any = grpc.load(path.join(__dirname, "backendserver", "backend.proto"))
      .backendserver;
    const cameraClient = new backend_proto.CameraService(
      "localhost:50051",
      grpc.credentials.createInsecure()
    );
    logger.debug("grpc client created");
    for (const meth of Object.keys(cameraClient.__proto__)) {
      const firstLetter = meth.substring(0, 1);

      if (firstLetter.toUpperCase() === firstLetter) {
        cameraClient[meth + "Async"] = util
          .promisify(cameraClient.__proto__[meth])
          .bind(cameraClient);
        logger.debug("Added function %s", meth + "Async");
      }
    }
    this.cameraClient = cameraClient;
    return this.cameraClient;
  }
}
