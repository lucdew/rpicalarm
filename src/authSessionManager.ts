import * as crypto from "crypto";
import * as EventEmitter from "events";
import * as api from "./api";
import * as log4js from "log4js";
import * as moment from "moment";
import * as util from "./util";
import { AuthSessionEvtName, IAuthSessionState, IAuthSessionEvt, RpicAlarmError } from "./api";

const logger = log4js.getLogger("AuthSessionManager");

function computeDigest(salt: string, pwd: string) {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(salt, "base64"));
  hash.update(pwd, "utf8");
  return hash.digest("hex");
}

class AuthState implements IAuthSessionState {
  nexts: Array<IAuthSessionState> = [];
  constructor(public name: string) {}
  isFinal() {
    return this.nexts.length === 0;
  }
  toString() {
    return this.name;
  }
}

export const MESSAGES = {
  AUTH_SUCCEEDED: "You have been authenticated.",
  FAILED: "Authentication failed, possible intrusion.",
  DONE: "Authentication successful.",
  INVALID_CRED_ENTERED: "Invalid password.",
  INVALID_DISARM_TIME: "Invalid disarm duration.",
  TIMEDOUT: "Authentication expired, possible intrusion.",
  ABORTED: "Authentication is not required anymore"
};

export const AuthStates = {
  CREATED: new AuthState("created"),
  STARTED: new AuthState("started"),
  AUTHED_WAITING_DISARM_DURATION: new AuthState("authed_waiting_disarm_duration"),
  AUTHED: new AuthState("authed"),
  ABORTED: new AuthState("aborted"),
  FAILED: new AuthState("failed")
};

AuthStates.CREATED.nexts = [AuthStates.STARTED, AuthStates.ABORTED, AuthStates.FAILED];
AuthStates.STARTED.nexts = [
  AuthStates.AUTHED_WAITING_DISARM_DURATION,
  AuthStates.AUTHED,
  AuthStates.ABORTED,
  AuthStates.FAILED
];
AuthStates.AUTHED_WAITING_DISARM_DURATION.nexts = [
  AuthStates.AUTHED,
  AuthStates.ABORTED,
  AuthStates.FAILED
];

type ChangeStateData = {
  err?: Error;
  disarmDuration?: moment.Duration;
  message: string;
  state?: IAuthSessionState;
  tries?: number;
};

class AuthSession implements api.IAuthSession {
  id: string;
  maxTries: number;
  tries = 0;
  authState: IAuthSessionState = AuthStates.CREATED;
  disarmDuration: moment.Duration;
  lastError: RpicAlarmError;
  lastMessage: string;
  lastUpdateTime = 0;

  private listeners: ((evt: IAuthSessionEvt) => void)[] = [];
  private authenticators: { [key: string]: api.IAuthenticator } = {};
  private failures: api.RpicAlarmError[];
  private digest: string;
  private salt: string;
  private authTtl: number;
  private disarmDurationTimer: NodeJS.Timer;

  constructor(
    authenticators: api.IAuthenticator[],
    {
      id = moment().format("YYYYMMDDHHmmssS"),
      digest,
      salt,
      authTtl = 5 * 60 * 1000,
      maxTries = 3
    }: {
      id?: string;
      digest: string;
      salt: string;
      authTtl: number;
      maxTries?: number;
    }
  ) {
    this.id = id;
    this.maxTries = maxTries;
    this.failures = [];
    this.digest = digest;
    this.salt = salt;
    this.authTtl = authTtl;
    this.lastUpdateTime = Date.now();

    authenticators.forEach(auth => {
      const authName = auth.name;
      this.authenticators[authName] = auth;
    });
  }

  setDisarmDuration(disarmDuration: string, isOnlyDigits: boolean, origin: string) {
    let duration;

    if (/^\s*0+\s*$/.test(disarmDuration)) {
      duration = moment.duration(0);
    } else {
      try {
        if (isOnlyDigits) {
          duration = util.parsePhoneDigitsDuration(disarmDuration);
        } else {
          duration = util.parseDuration(disarmDuration, "h");
        }
      } catch (err) {
        const durationErr = new RpicAlarmError("invalid disarm time " + disarmDuration);
        logger.error("Got error ", durationErr.message);
        this.createDisarmDurationTimer(origin); // update the timer
        this.changeState({ err, message: MESSAGES.INVALID_DISARM_TIME }, origin);
        throw err;
      }
    }
    const message =
      duration.asMilliseconds() === 0
        ? "Thanks alarm disabled."
        : `Thanks, alarm disarmed for ${duration.humanize()}. `;
    this.changeState(
      {
        state: AuthStates.AUTHED,
        message,
        disarmDuration: duration
      },
      origin
    );
  }

  reportFailure(err: api.RpicAlarmError, origin: string, message?: string) {
    this.failures.push(err);
    if (err instanceof api.AuthError) {
      logger.error("Failed authentication for [%s], reason=[%s]", origin, err.message);
      this.changeState({ state: AuthStates.FAILED, err, message: message || err.message }, origin);
    } else {
      logger.error("An error occurred while authentication for [%s]", origin, err);
      if (this.failures.length === Object.keys(this.authenticators).length) {
        this.fail(new api.AggregatorError(this.failures), origin);
      }
    }
  }

  endInSuccess(origin: string) {
    this.changeState({ state: AuthStates.AUTHED, message: MESSAGES.DONE }, origin);
  }

  private reportAuthSuccess(origin: string) {
    this.changeState(
      { state: AuthStates.AUTHED_WAITING_DISARM_DURATION, message: MESSAGES.AUTH_SUCCEEDED },
      origin
    );

    this.createDisarmDurationTimer(origin);
  }

  private createDisarmDurationTimer(origin: string) {
    if (this.disarmDuration) {
      return;
    }
    if (this.disarmDurationTimer) {
      clearTimeout(this.disarmDurationTimer);
      this.disarmDurationTimer = undefined;
    }
    this.disarmDurationTimer = setTimeout(() => {
      if (!this.disarmDuration && this.authState.isFinal()) {
        this.changeState({ state: AuthStates.AUTHED, message: MESSAGES.DONE }, origin);
      }
    }, 20000); // wait another 20 seconds to have disarm duration set if not already set
  }

  startAuthentication() {
    setTimeout(() => {
      this.authTimeout();
    }, this.authTtl);
    this.changeState({ state: AuthStates.STARTED, message: "" }, "internal");
    for (const authName in this.authenticators) {
      const auth = this.authenticators[authName];
      setTimeout(() => {
        if (!this.authState.isFinal()) {
          auth.authenticate(this).catch(err => {
            logger.error("An unxpected error occurred doing the authentication", err);
          });
        }
      }, auth.delay || 0);
    }
  }

  abort(origin: string) {
    this.changeState({ state: AuthStates.ABORTED, message: MESSAGES.ABORTED }, origin);
  }

  private authTimeout() {
    if (this.authState.isFinal() || this.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
      logger.debug("auth timeout but nothing to do %s", this.authState.name);
      return;
    }
    const authTimeoutMessage = `Authentication timeout of ${this.authTtl} ms exceeded`;
    logger.error(authTimeoutMessage);
    this.reportFailure(new api.AuthTimeoutError(authTimeoutMessage), "internal", MESSAGES.FAILED);
  }

  authenticate(credential: string, origin: string) {
    logger.debug("Password %s", credential);
    logger.debug("Salt %s", this.salt);
    const verif = computeDigest(this.salt, credential) === this.digest;
    if (verif) {
      this.reportAuthSuccess(origin);
      return true;
    }
    const tries = this.tries + 1;
    if (tries === this.maxTries) {
      this.reportFailure(new api.AuthError(MESSAGES.FAILED), origin);
    } else {
      const remainingTries = this.maxTries - tries;
      const msgSuffix = ` You have ${remainingTries} ${
        remainingTries > 1 ? "tries" : "try"
      } remaining.`;
      this.changeState({ tries, message: MESSAGES.INVALID_CRED_ENTERED + msgSuffix }, origin);
    }
    return false;
  }

  toString() {
    return `[id=${this.id},authState=${this.authState},_authTtl=${this.authTtl},maxTries=${
      this.maxTries
    },_salt=${this.salt}]`;
  }

  registerListener(listener: (evt: IAuthSessionEvt) => void): void {
    this.listeners.push(listener);
  }

  removeAllListeners() {
    this.listeners = [];
  }

  private async notifyListeners(origin: string) {
    for (const listener of this.listeners) {
      try {
        await listener({
          session: this,
          origin
        });
      } catch (err) {
        logger.error("Listener invocation failed", err);
      }
    }
  }

  private changeState(stateData: ChangeStateData, origin: string) {
    logger.debug("Changing state to %j from [%s]", stateData, origin);
    if (this.authState.isFinal()) {
      return; // already changed state
    }
    if (stateData.state) {
      this.authState = stateData.state;
    }
    if (stateData.tries) {
      this.tries = stateData.tries;
    }
    if (stateData.disarmDuration) {
      this.disarmDuration = stateData.disarmDuration;
    }
    this.lastError = stateData.err;
    this.lastMessage = stateData.message;
    this.lastUpdateTime = Date.now();
    this.notifyListeners(origin).catch(err => logger.error(err));
  }

  private fail(err: api.RpicAlarmError, origin: string): void {
    this.lastError = err;
    this.changeState({ state: AuthStates.FAILED, err, message: MESSAGES.FAILED }, origin);
  }
}

class AuthSessionManager extends EventEmitter {
  private sessions: { [id: string]: api.IAuthSession } = {};
  constructor() {
    super();
  }

  createAuthSession(
    pwd: string,
    authTtl: number,
    authenticators: api.IAuthenticator[]
  ): api.IAuthSession {
    const salt = crypto.randomBytes(16).toString("base64");
    const digest = computeDigest(salt, pwd);
    const authSession = new AuthSession(authenticators, {
      digest,
      salt,
      authTtl
    });
    this.sessions[authSession.id] = authSession;
    setTimeout(() => {
      delete this.sessions[authSession.id];
    }, authTtl + 10 * 60 * 1000);

    return authSession;
  }

  getSession(sessionId: string): api.IAuthSession {
    return this.sessions[sessionId];
  }
}

export const instance = new AuthSessionManager();
