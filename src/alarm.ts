import { EventEmitter } from "events";
import * as moment from "moment";
import * as util from "./util";
import * as log4js from "log4js";
import {
  IAgent,
  IConfiguration,
  IAlarmSettings,
  ISessionInfo,
  IAuthenticator,
  IRecorder,
  ISensor,
  INotifier,
  IAuthSessionEvt
} from "./api";
import { instance as authSessionManager, AuthStates } from "./authSessionManager";

const logger = log4js.getLogger("alarm");

interface AlarmState {
  name: string;
  nexts: AlarmState[];
}

const STATES: {
  [key: string]: AlarmState;
} = {
  DISARMED: {
    name: "disarmed",
    get nexts(): AlarmState[] {
      return [STATES.ENABLED, STATES.DISABLED];
    }
  },
  ALARMING: {
    name: "alarming",
    get nexts(): AlarmState[] {
      return [STATES.ENABLED, STATES.DISABLED, STATES.DISARMED];
    }
  },
  AUTHENTICATING: {
    name: "authenticating",
    get nexts(): AlarmState[] {
      return [STATES.ENABLED, STATES.DISABLED, STATES.DISARMED];
    }
  },
  ENABLED: {
    name: "enabled",
    get nexts(): AlarmState[] {
      return [STATES.DISABLED, STATES.DISARMED, STATES.AUTHENTICATING];
    }
  },
  DISABLED: {
    name: "disabled",
    get nexts(): AlarmState[] {
      return [STATES.ENABLED, STATES.DISARMED];
    }
  }
};

async function execAllSequential(targets: IAgent[], funcName: string, ...args: any[]) {
  for (const target of targets) {
    let op: () => Promise<any> = <() => Promise<any>>(<any>target)[funcName];
    if (!op) {
      throw new Error(`Missing function ${funcName} on agent ${target.name}`);
    }
    try {
      await op.apply(target, args);
      logger.debug(`Executed ${util.getMemberFunctionName(op)} on ${target.name}`);
    } catch (err) {
      logger.error(
        "Failed executing %s on %s named %s",
        op.toString(),
        typeof target,
        target.name,
        err
      );
    }
  }
}

interface AlarmTimer extends NodeJS.Timer {
  nextExecutionDate?: number;
}

export default class Alarm extends EventEmitter {
  state: AlarmState = STATES.DISARMED;
  authTtl: number;
  defaultDisarmTtl: number;
  password: string;
  private _authenticators: IAuthenticator[];
  private _recorders: IRecorder[];
  private _sensors: ISensor[];
  private _notifiers: INotifier[];
  private sessionId: string;
  private enableTimer: AlarmTimer;

  constructor(cfg: IAlarmSettings) {
    super();
    this.authTtl = util.parseDuration(cfg.maxAuthTime).asMilliseconds();
    this.defaultDisarmTtl = util.parseDuration(cfg.defaultDisarmTime).asMilliseconds();
    this.password = cfg.password;
  }

  intrusionDetected(sessionInfo: ISessionInfo): void {
    this.emit("intrusionDetected", sessionInfo);
    this.state = STATES.ALARMING;
    this.notifyOfIntrusion(moment().format("dddd, MMMM Do YYYY, HH:mm:ss"));
  }

  set authenticators(authenticators: IAuthenticator[]) {
    this._authenticators = authenticators;
    logger.debug("Setting authenticators " + this._authenticators.map(a => a.name).join(","));
  }

  set recorders(recorders: IRecorder[]) {
    this._recorders = recorders;
    logger.debug("Setting recorders " + this._recorders.map(a => a.name).join(","));
  }

  set sensors(sensors: ISensor[]) {
    this._sensors = sensors;
    logger.debug("Setting sensors " + this._sensors.map(a => a.name).join(","));
  }

  set notifiers(notifiers: INotifier[]) {
    this._notifiers = notifiers;
    logger.debug("Setting notifiers " + this._notifiers.map(a => a.name).join(","));
  }

  motionDetected() {
    if (!this.state.nexts.includes(STATES.AUTHENTICATING)) {
      logger.debug(
        "Motion detected, transition to [%s] state not allowed from [%s]",
        STATES.AUTHENTICATING.name,
        this.state.name
      );
      return;
    }
    const authSession = authSessionManager.createAuthSession(
      this.password,
      this.authTtl,
      this._authenticators
    );
    this.sessionId = authSession.id;

    const disableListener = (evt: any) => {
      authSession.abort(evt.origin);
      delete this.sessionId;
    };
    this.once("disabled", disableListener);

    logger.info("Registering alarm listener");
    authSession.registerListener(async (evt: IAuthSessionEvt) => {
      const session = evt.session;
      try {
        if (session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
          logger.info("Authentication succeeded");
          this.removeListener("disabled", disableListener);
          await this.stopRecorders();
        } else if (session.authState === AuthStates.FAILED) {
          this.removeListener("disabled", disableListener);
          logger.debug("Auth failure error", session.lastError);
          logger.error("Failed authentication");
          delete this.sessionId;
          this.intrusionDetected({
            sessionId: session.id,
            intrusionDate: new Date()
          });
        } else if (session.authState === AuthStates.AUTHED) {
          delete this.sessionId;
          if (!session.disarmDuration || session.disarmDuration.asMilliseconds() === 0) {
            await this.disable(evt.origin);
          } else {
            await this.disarm(session.disarmDuration, authSession.id);
          }
        }
      } catch (err) {
        logger.error(err);
      }
    });

    this.state = STATES.AUTHENTICATING;
    this.emit("authenticating", {
      sessionId: authSession.id
    });

    authSession.startAuthentication();
    this.startRecordersInWarning({
      sessionId: authSession.id
    });
  }

  async disable(origin: string) {
    this.state = STATES.DISABLED;
    await this.stopSensors();
    await this.cancelEnableTimer();
    await this.stopRecorders();
    logger.info("Alarm disabled");
    const sessionId = this.sessionId;
    this.emit("disabled", {
      sessionId,
      origin
    });
  }

  async disarm(duration: moment.Duration, sessionId?: string) {
    this.state = STATES.DISARMED;
    this.emit("disarmed", {
      sessionId
    });
    const timeout = duration ? duration.asMilliseconds() : this.defaultDisarmTtl;

    await this.stopRecorders();
    await this.stopSensors();
    logger.info(
      "Alarm disarmed for roughly [%s], exact duration [%s] ",
      moment.duration(timeout).humanize(),
      timeout
    );
    this.scheduleEnable(timeout);
  }

  scheduleEnable(timeout: number) {
    this.cancelEnableTimer();
    this.enableTimer = setTimeout(() => {
      this.enable();
    }, timeout);
    this.enableTimer.nextExecutionDate = Date.now() + timeout;
    logger.info("Schedule enable timer is=" + this.enableTimer);
  }

  get nextEnableDate() {
    logger.info("Get enable timer is=" + this.enableTimer);
    if (this.enableTimer) {
      return moment(this.enableTimer.nextExecutionDate).format("dddd, MMMM Do YYYY, HH:mm:ss");
    }
  }

  get STATES() {
    return STATES;
  }

  cancelEnableTimer() {
    if (this.enableTimer) {
      logger.info("Cancel enable timer is=" + this.enableTimer);
      clearTimeout(this.enableTimer);
      this.enableTimer = undefined;
    }
  }

  async enable() {
    this.state = STATES.ENABLED;
    logger.info("Alarm enabled");
    this.cancelEnableTimer();
    this.emit("enabled");
    await this.startSensors();
  }

  async startSensors() {
    await execAllSequential(this._sensors, "start");
  }

  async stopSensors() {
    await execAllSequential(this._sensors, "stop");
  }

  async stopRecorders() {
    await execAllSequential(this._recorders, "stopRecording");
  }

  async startRecordersInWarning(...opts: any[]) {
    await execAllSequential(this._recorders, "startWarningRecording", ...opts);
  }

  notifyOfIntrusion(...opts: any[]) {
    execAllSequential(this._notifiers, "notify", ...opts).catch(err => logger.error(err));
  }
}
