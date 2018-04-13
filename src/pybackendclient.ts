import { spawn, ChildProcess } from "child_process";
import * as log4js from "log4js";
import * as net from "net";
import * as path from "path";

const logger = log4js.getLogger("pybackendclient");

export default class PyBackendClient {
  pythonBackendProc: ChildProcess;

  public constructor(public cwd: string) {}

  private async connect(): Promise<void> {
    if (this.pythonBackendProc) {
      return;
    }
    const cmd = `python3 ${path.resolve(__dirname)}/pycmdserver-cli.py -v True -c ${
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
        if (data.toString().includes("pycmdserver started")) {
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

  async request(msg: any): Promise<Buffer | void> {
    await this.connect();

    const client = net.createConnection("/tmp/rpicalarm-pybackend.sock");
    client.setTimeout(30000);
    let status = false;
    let appError = false;
    let res = Buffer.alloc(0);

    return new Promise<Buffer | void>((resolve, reject) => {
      if (!this.pythonBackendProc) {
        return reject(new Error("Process died"));
      }
      client.on("connect", function() {
        const cmd = JSON.stringify(msg);
        const b = Buffer.alloc(cmd.length + 1);
        b.write(cmd, 0, cmd.length, "utf-8");
        b.write("0A", cmd.length, 1, "hex");
        logger.debug("Sending python backend message: %s", b.toString("hex"));
        client.write(b);
      });
      client.on("error", err => {
        client.end();
        reject(err);
      });

      client.on("close", (had_error: boolean) => {
        if (had_error) {
          return;
        }
        if (!appError) {
          return resolve(res);
        } else {
          const errorMsg = res.length > 0 ? res.toString("utf-8") : "Server error";
          return reject(new Error(errorMsg));
        }
      });

      client.on("data", function(data) {
        if (!status) {
          if (data.length >= 2 && data[0] === 0 && data[1] === 10) {
            status = true;
            data = data.slice(2);
          } else if (data.length >= 2 && data[0] === 1 && data[1] === 10) {
            appError = true;
            status = true;
            data = data.slice(2);
          } else {
            client.end();
            return reject(new Error("Unexpected error"));
          }
        }
        if (status) {
          res = Buffer.concat([res, data]);
        }
      });

      client.on("timeout", () => {
        client.end();
        reject(new Error("timeout"));
      });
    });
  }
}
