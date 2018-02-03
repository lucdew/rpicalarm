//@ts-ignore
import * as twilio from "twilio";
import * as log4js from "log4js";
import { instance as authSessionManager, AuthStates } from "../authSessionManager";
import * as util from "../util";
import * as express from "express";
import WebServer from "../webServer";
import {
  IControlCenter,
  IAuthenticator,
  ITwilioConfig,
  IAuthSession,
  IAuthSessionEvt,
  AuthTimeoutError
} from "../api";
import * as moment from "moment";
import * as networkManager from "../networkManager";

const logger = log4js.getLogger("twilio");

const ROUTER_BASE_PATH = "/twilio";
const AGENT_NAME = "twilio";

let twimlMessage: any;

class TwimlServer {
  private baseReplyUrl: string;
  private statusCbBasePath = "/statusCb/failure/";
  private authActionBasePath = "/actions/auth/";

  constructor(public webServer: WebServer, authToken?: string) {
    const router = webServer.createRouter(ROUTER_BASE_PATH);
    const twilioWebHook = twilio.webhook(authToken);
    router.post(
      `${this.statusCbBasePath}:sessionId`,
      twilioWebHook,
      this.failedCbMiddleware.bind(this)
    );
    router.post(
      `${this.authActionBasePath}:sessionId`,
      twilioWebHook,
      this.authActionMiddleware.bind(this)
    );
  }

  async updateBaseReplyUrl(): Promise<string> {
    const ip = await networkManager.getExternalIp();
    this.baseReplyUrl = `http://${this.webServer.settings.authUsername}:${
      this.webServer.settings.authPassword
    }@${ip}:3000${ROUTER_BASE_PATH}`;
    return this.baseReplyUrl;
  }

  getStatusCbUrl(sessionId: string): string {
    return `${this.baseReplyUrl}${this.statusCbBasePath}${sessionId}`;
  }

  getAuthActionUrl(sessionId: string): string {
    return `${this.baseReplyUrl}${this.authActionBasePath}${sessionId}?ts=${Date.now()}`;
  }

  failedCbMiddleware(req: express.Request, res: express.Response) {
    const session = authSessionManager.getSession(req.params.sessionId);
    if (session) {
      session.reportFailure(new Error("Call ended with status " + req.body.CallStatus), "twilio");
    }
    res.status(200).end();
  }

  sendTwiml(res: express.Response, twiml: any) {
    const rawTwiml = twiml.toString();
    logger.debug("raw twiml " + rawTwiml);
    res.status(200);
    res.send(rawTwiml);
  }

  authActionMiddleware(req: express.Request, res: express.Response) {
    logger.debug("Got req %j", req.body);
    const session = authSessionManager.getSession(req.params.sessionId);
    logger.debug("session %s", session);

    const ts = req.query.ts ? parseInt(req.query.ts) : undefined;
    const sessionUpdatedSinceLastResponse = ts && session.lastUpdateTime > ts;
    console.log(sessionUpdatedSinceLastResponse);

    const twiml = new twilio.twiml.VoiceResponse();
    const getGather = () => ({
      action: this.getAuthActionUrl(session.id),
      timeout: 30,
      finishOnKey: "#"
    });
    res.set("Content-Type", "text/xml");
    if (session.authState === AuthStates.FAILED) {
      if (session.lastError instanceof AuthTimeoutError) {
        twiml.say("Authentication timed out, possible intrusion");
      } else {
        twiml.say("Authentication failed, possible intrusion");
      }
    } else if (session.authState === AuthStates.AUTHED) {
      twiml.say(
        `thanks, alarm disarmed for ${
          session.disarmDuration ? session.disarmDuration.humanize() : "some time"
        }`
      );
    } else if (session.authState === AuthStates.ABORTED) {
      twimlMessage = twiml.say("Authentication is not required anymore");
    } else if (
      session.authState === AuthStates.STARTED &&
      session.tries === 0 &&
      !req.body.Digits
    ) {
      twiml.say("Hi this is your rpialarm speaking");
      twiml.gather(getGather());
      twiml.say("Please enter your password followed by the pound key");
    } else if (session.authState === AuthStates.STARTED) {
      if (!session.authenticate(req.body.Digits, AGENT_NAME)) {
        if (session.authState === AuthStates.FAILED) {
          twiml.say("Maximum number of tries reached, goodbye");
        } else {
          const remainingTries = session.maxTries - session.tries;
          twiml.say(
            `Authentication failed, you have ${remainingTries} ${
              remainingTries > 1 ? "tries" : "try"
            } remaining`
          );
          twiml.gather(getGather());
          twiml.say("Please enter your password followed by the pound key");
        }
      } else {
        twiml.say("Authentication succeeded");
        twiml.gather(getGather());
        twiml.say("Enter disarm time followed by the pound key, last digit is the unit");
      }
    } else if (session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
      // If another authenticator authenticated the user the input values is the password
      // not the disarm duration
      if (sessionUpdatedSinceLastResponse) {
        twiml.say("Authentication succeeded");
        twiml.gather(getGather());
        twiml.say("Enter disarm time, last digit is the unit");
      } else {
        try {
          const duration = util.parsePhoneDigitsDuration(req.body.Digits);
          twiml.say(`Thanks, alarm disarmed for ${duration.humanize()}`);
          session.setDisarmDuration(duration, "twilio");
        } catch (err) {
          twiml.say("Invalid duration");
          twiml.gather(getGather());
          twiml.say("Enter disarm time, last digit is the unit, followed by the pound key");
        }
      }
    }

    return this.sendTwiml(res, twiml);
  }
}

export default class TwilioAgent implements IAuthenticator {
  public name = AGENT_NAME;
  public delay: moment.Duration;
  public twimlServer: TwimlServer;
  private twilioClient: any;

  constructor(public twilioConfig: ITwilioConfig, webServer: WebServer) {
    this.twilioClient = twilio(twilioConfig.accountSid, twilioConfig.authToken);
    this.twimlServer = new TwimlServer(webServer, twilioConfig.authToken);
  }

  async authenticate(session: IAuthSession): Promise<any> {
    logger.debug("Starting twilio authentication");
    if (session.authState.isFinal()) {
      return Promise.resolve();
    }

    try {
      await this.twimlServer.updateBaseReplyUrl();
      const authActionUrl = this.twimlServer.getAuthActionUrl(session.id);
      const statusUrl = this.twimlServer.getStatusCbUrl(session.id);
      const call = await this.twilioClient.calls.create({
        url: authActionUrl,
        to: this.twilioConfig.mobilePhoneNumber,
        from: this.twilioConfig.landlinePhoneNumber,
        statusCallback: statusUrl,
        statusCallbackEvent: ["busy", "failed", "no_answer", "canceled"]
      });
      logger.info(
        `Called made to [${this.twilioConfig.mobilePhoneNumber}] from [${
          this.twilioConfig.landlinePhoneNumber
        }] with uri [${call.uri}]`
      );
    } catch (err) {
      session.reportFailure(err, this.name);
    }
  }

  async notify(date: Date): Promise<any> {
    // Not working
    // SMS requires to pay a phone number to set the from address

    await this.twilioClient.messages.create({
      to: this.twilioConfig.mobilePhoneNumber,
      from: "rpicalarm",
      body: "[rpicalarm] intrusion detected at " + date
    });
  }
}
