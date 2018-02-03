import * as crypto from "crypto";
import * as EventEmitter from "events";
import * as api from "./api";
import * as log4js from "log4js";
import * as moment from "moment";
import { AuthSessionEvtName, IAuthSessionState, IAuthSessionEvt, RpicAlarmError } from "./api";

const logger = log4js.getLogger("AuthSessionManager");

function computeDigest(salt: string, pwd: string) {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(salt, "base64"));
  hash.update(pwd, "utf8");
  return hash.digest("hex");
}

class AuthState implements IAuthSessionState {
  constructor(public name: string, public getNextsFunc: () => IAuthSessionState[]) {}
  get nexts() {
    return this.getNextsFunc();
  }
  isFinal() {
    return this.nexts.length === 0;
  }
  toString() {
    return this.name;
  }
}

export const AuthStates: { [key: string]: IAuthSessionState } = {
  CREATED: new AuthState("created", () => [
    AuthStates.STARTED,
    AuthStates.ABORTED,
    AuthStates.FAILED
  ]),
  STARTED: new AuthState("started", () => [
    AuthStates.AUTHED_WAITING_DISARM_DURATION,
    AuthStates.AUTHED,
    AuthStates.ABORTED,
    AuthStates.FAILED
  ]),
  AUTHED_WAITING_DISARM_DURATION: new AuthState("started", () => [
    AuthStates.AUTHED,
    AuthStates.ABORTED,
    AuthStates.FAILED
  ]),
  AUTHED: new AuthState("authed", () => []),
  ABORTED: new AuthState("aborted", () => []),
  FAILED: new AuthState("failed", () => [])
};

type EvtData = { origin?: string; err?: Error; disarmDuration?: moment.Duration };

class AuthSession implements api.IAuthSession {
  id: string;
  maxTries: number;
  tries = 0;
  authState: IAuthSessionState = AuthStates.CREATED;
  disarmDuration: moment.Duration;
  lastError: RpicAlarmError;
  lastUpdateTime = 0;

  private listeners: ((evt: IAuthSessionEvt) => void)[] = [];
  private authenticators: { [key: string]: api.IAuthenticator } = {};
  private failures: api.RpicAlarmError[];
  private digest: string;
  private salt: string;
  private authTtl: number;

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

  setDisarmDuration(disarmDuration: moment.Duration, origin: string) {
    this.disarmDuration = disarmDuration;
    this.changeState(AuthStates.AUTHED, { disarmDuration, origin });
  }

  reportFailure(err: api.RpicAlarmError, origin: string) {
    this.failures.push(err);
    if (err instanceof api.AuthError) {
      logger.error("Failed authentication for [%s], reason=[%s]", origin, err.message);
    } else {
      logger.error("An error occurred while authentication for [%s]", origin, err);
      if (this.failures.length === Object.keys(this.authenticators).length) {
        this.fail(new api.AggregatorError(this.failures));
      }
    }
  }
  private reportAuthSuccess(origin: string) {
    this.changeState(AuthStates.AUTHED_WAITING_DISARM_DURATION, { origin });

    if (!this.disarmDuration) {
      setTimeout(() => {
        if (!this.disarmDuration) {
          this.changeState(AuthStates.AUTHED, { origin });
        }
      }, 60000); // wait another 1mn to have disarm duration set if not already set
    }
  }

  startAuthentication() {
    setTimeout(() => {
      this.authTimeout();
    }, this.authTtl);
    this.changeState(AuthStates.STARTED);
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

  abort() {
    this.changeState(AuthStates.ABORTED);
  }

  private authTimeout() {
    const authTimeoutMessage = `Authentication timeout of ${this.authTtl} ms exceeded`;
    logger.error(authTimeoutMessage);
    this.fail(new api.AuthTimeoutError(authTimeoutMessage));
  }

  authenticate(credential: string, origin: string) {
    logger.debug("Password %s", credential);
    logger.debug("Salt %s", this.salt);
    const verif = computeDigest(this.salt, credential) === this.digest;
    if (verif) {
      this.reportAuthSuccess(origin);
      return true;
    }
    this.tries += 1;
    if (this.tries === this.maxTries) {
      this.reportFailure(new api.AuthError("Max tries reached"), origin);
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

  private changeState(newState: IAuthSessionState, evtData?: EvtData) {
    if (!this.authState.isFinal()) {
      const previousState = this.authState;
      this.authState = newState;
      this.lastUpdateTime = Date.now();
      for (const listener of this.listeners) {
        try {
          listener({
            newState,
            changeStateTime: this.lastUpdateTime,
            previousState,
            origin: evtData && evtData.origin,
            err: evtData && evtData.err
          });
        } catch (err) {
          logger.error("Listener invocation failed", err);
        }
      }
      if (newState.isFinal()) {
        this.removeAllListeners();
      }
    }
  }

  private fail(err: api.RpicAlarmError): void {
    this.lastError = err;
    this.changeState(AuthStates.FAILED, { err });
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
