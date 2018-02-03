import * as fs from "fs";
import * as log4js from "log4js";
import * as toml from "toml";
import Alarm from "./alarm";
import { argv as yargs } from "yargs";
import * as util from "./util";
import { IAlarmSettings, IConfiguration, ISessionInfo } from "./api";

import CloudinaryAgent from "./agent/cloudinary";
import Camera from "./agent/camera";
import { TelegramAgent } from "./agent/telegram";
import PirSensorAgent from "./agent/pirsensor";
import EmailAgent from "./agent/email";
import TwilioAgent from "./agent/twilio";

import Backup from "./backup";
import WebServer from "./webServer";

const logger = log4js.getLogger("rpicalarm");
logger.constructor.prototype.fatal = function() {
  this.error.apply(this, arguments);
  process.exit(-1);
};

function fromSnakeKeysToCamelKeys(obj: any) {
  Object.keys(obj).forEach(k => {
    const v = (<any>obj)[k];
    if (k.includes("_")) {
      const aKey = k.replace(/_(.{1})/g, (match, p1: string) => p1.toUpperCase());
      obj[aKey] = v;
      delete obj[k];
    }
    if (v instanceof Object) {
      fromSnakeKeysToCamelKeys(v);
    }
  });
}

function loadConf(cfgFile: string) {
  const cfgContent = fs.readFileSync(cfgFile).toString();
  const cfg = toml.parse(cfgContent);
  fromSnakeKeysToCamelKeys(cfg);
  return cfg;
}

const cfgFile = yargs.c || yargs.cfg || "/etc/rpicalarm/rpicalarm.conf";

const cfg: IConfiguration = loadConf(cfgFile);

if (cfg.logging && cfg.logging.level) {
  log4js.configure({
    appenders: {
      stdout: { type: "stdout" }
    },
    categories: {
      default: { appenders: ["stdout"], level: cfg.logging.level }
    }
  });
}

const alarm = new Alarm(cfg.alarm);
const camera = new Camera(cfg.agents.camera);
const webServer = new WebServer(cfg.webServer);
const telegram = new TelegramAgent(cfg.agents.telegram, alarm, camera);
const backupAgents = [new CloudinaryAgent(cfg.agents.cloudinary)];
const authAgents = [telegram, new TwilioAgent(cfg.agents.twilio, webServer)];
const recordingAgents = [camera];
const sensorAgents = [new PirSensorAgent(cfg.agents.pirsensor.pinNum, alarm)];
const ccs = [telegram];
const notifierAgents = [new EmailAgent(cfg.agents.email)];

const enabledAuthAgents = [];
for (const auth of cfg.alarm.authenticators || []) {
  const foundAg = authAgents.find(agent => agent.name === auth.name);
  if (!foundAg) {
    logger.fatal("Invalid authenticator name %s ", auth.name);
  }
  if (auth.delay) {
    try {
      const duration = util.parseDuration(auth.delay);
      foundAg.delay = duration;
    } catch (err) {
      logger.fatal("Invalid delay % for authenticator named %s", auth.delay, auth.name);
    }
  }
  enabledAuthAgents.push(foundAg);
}
alarm.authenticators = enabledAuthAgents;
alarm.recorders = recordingAgents;
alarm.sensors = sensorAgents;
alarm.notifiers = notifierAgents;

alarm.on("authenticating", () => {
  logger.debug("checking for normal presence");
});

alarm.on("intrusionDetected", () => {
  logger.info("Instrusion detected");
});

const backupClean = ({ sessionId }: ISessionInfo) => backup.clean(sessionId);
alarm.on("disarmed", backupClean);
alarm.on("disabled", backupClean);

const backup = new Backup(backupAgents);
for (const recordingAgent of recordingAgents) {
  backup.sync(recordingAgent.assetsSavePath);
}

(async () => {
  for (const cc of ccs) {
    await cc.start();
  }
  await webServer.start();
  await alarm.enable();
  logger.info("RPICalarm started");
})().catch(err => {
  logger.error("Failed starting app", err);
  process.exit(-1);
});
