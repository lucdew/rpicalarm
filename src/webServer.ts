import * as bodyParser from "body-parser";
import * as express from "express";
import * as fs from "fs";
//@ts-ignore
import * as FileStreamRotator from "file-stream-rotator";
import * as http from "http";
import * as log4js from "log4js";
import * as morgan from "morgan";
import * as path from "path";
import * as passport from "passport";
import * as passporthttp from "passport-http";
import { IWebServerSettings } from "./api";

const logger = log4js.getLogger("webServer");

const Strategy = passporthttp.DigestStrategy;

export default class WebServer {
  public webapp: express.Express;
  private httpServer: http.Server;

  constructor(public settings: IWebServerSettings) {
    this._init();
  }
  _init() {
    fs.existsSync(this.settings.logDir) || fs.mkdirSync(this.settings.logDir);

    const accessLogStream = FileStreamRotator.getStream({
      date_format: "YYYYMMDD",
      filename: path.join(this.settings.logDir, "access-%DATE%.log"),
      frequency: "daily",
      verbose: false
    });

    if (this.settings.authUsername) {
      passport.use(
        new Strategy(
          {
            qop: "auth"
          },
          (username, cb) => {
            if (this.settings.authUsername !== username) {
              return cb(null, false);
            }
            return cb(null, this.settings.authUsername, this.settings.authPassword);
          }
        )
      );
    }

    const webapp = express();
    webapp.disable("x-powered-by");
    webapp.set("port", process.env.PORT || this.settings.port);
    webapp.use(
      bodyParser.urlencoded({
        extended: true
      })
    );
    webapp.use(
      bodyParser.json({
        limit: "500kb"
      })
    );
    morgan.token("headers", function(req, res) {
      const headers = [];
      for (const hName in req.headers) {
        headers.push(`${hName}=${req.headers[hName]}`);
      }
      return `headers[${headers.join(",")}]`;
    });
    webapp.use(
      morgan(
        'remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" ":headers"',
        {
          stream: accessLogStream
        }
      )
    );

    if (this.settings.authUsername) {
      webapp.use(
        passport.authenticate("digest", {
          session: false
        })
      );
    }
    this.webapp = webapp;
    this.httpServer = http.createServer(webapp);
  }
  createRouter(path: string) {
    const router = express.Router();
    this.webapp.use(path, router);
    return router;
  }
  async start() {
    return new Promise((res, rej) => {
      this.httpServer.on("error", err => rej(err));
      const port = this.webapp.get("port");
      this.httpServer.listen(port, () => {
        logger.info("Web server listening on port " + port);
        return res();
      });
    });
  }
  async stop() {
    this.httpServer.close();
  }
}
