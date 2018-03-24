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
  private statusCbBasePath = "/statusCb/";
  private authActionBasePath = "/actions/auth/";

  constructor(public webServer: WebServer, authToken?: string) {
    const router = webServer.createRouter(ROUTER_BASE_PATH);
    const twilioWebHook = twilio.webhook(authToken);
    router.post(
      `${this.statusCbBasePath}:sessionId`,
      twilioWebHook,
      this.callStatusCbMiddleware.bind(this)
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

  callStatusCbMiddleware(req: express.Request, res: express.Response) {
    const session = authSessionManager.getSession(req.params.sessionId);
    if (session) {
      if (session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
        session.endInSuccess(AGENT_NAME);
      } else if (!session.authState.isFinal()) {
        session.reportFailure(
          new Error("Call ended with status " + req.body.CallStatus),
          AGENT_NAME
        );
      }
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

    const twiml = new twilio.twiml.VoiceResponse();
    const getGather = () => ({
      action: this.getAuthActionUrl(session.id),
      timeout: 30,
      finishOnKey: "#"
    });
    res.set("Content-Type", "text/xml");
    if (session.authState.isFinal()) {
      twiml.say(session.lastMessage);
      twiml.say("Goodbye.");
      twiml.hangup();
    } else if (session.authState === AuthStates.STARTED && !req.body.Digits) {
      twiml.say("Hi this is your alarm speaking");
      twiml.gather(getGather()).say("Please enter your password followed by the pound key");
    } else if (session.authState === AuthStates.STARTED) {
      if (!session.authenticate(req.body.Digits, AGENT_NAME)) {
        if (session.authState === AuthStates.FAILED) {
          twiml.say("Maximum number of tries reached, goodbye");
        } else {
          twiml.say(session.lastMessage);
          twiml.gather(getGather()).say("Please enter your password followed by the pound key");
        }
      } else {
        twiml.say(session.lastMessage);
        twiml
          .gather(getGather())
          .say(
            "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm."
          );
      }
    } else if (session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
      // If another authenticator authenticated the user the input values is the password
      // not the disarm duration
      if (sessionUpdatedSinceLastResponse) {
        twiml.say(session.lastMessage);
        twiml
          .gather(getGather())
          .say(
            "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm."
          );
      } else {
        try {
          session.setDisarmDuration(req.body.Digits, true, "twilio");
          twiml.say(session.lastMessage);
          twiml.say("Goodbye.");
          twiml.hangup();
        } catch (err) {
          twiml.say(session.lastMessage);
          twiml
            .gather(getGather())
            .say("Enter disarm time, last digit is the unit, followed by the pound key");
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
    if (
      session.authState.isFinal() ||
      session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION
    ) {
      return Promise.resolve();
    }

    try {
      await this.twimlServer.updateBaseReplyUrl();
      const authActionUrl = this.twimlServer.getAuthActionUrl(session.id);
      const statusUrl = this.twimlServer.getStatusCbUrl(session.id);
      const twilioCallData = {
        url: authActionUrl,
        to: this.twilioConfig.mobilePhoneNumber,
        from: this.twilioConfig.landlinePhoneNumber,
        statusCallback: statusUrl,
        statusCallbackEvent: ["completed"]
      };
      const call = await this.twilioClient.calls.create(twilioCallData);
      logger.info("Call made with %j", twilioCallData);
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
