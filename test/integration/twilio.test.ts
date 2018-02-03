import TwilioAgent from "../../src/agent/twilio";
//@ts-ignore
import * as twilio from "twilio";
import { instance as authSessionManager, AuthStates } from "../../src/authSessionManager";
import * as log4js from "log4js";
import WebServer, * as webServer from "../../src/webServer";
import * as request from "supertest";
import * as networkManager from "../../src/networkManager";
import { IWebServerSettings } from "../../src/api";

const PWD = "dummyPwd";

log4js.configure({
  appenders: {
    stdout: { type: "stdout" }
  },
  categories: {
    default: { appenders: ["stdout"], level: "debug" }
  }
});

jest.useFakeTimers();
jest.mock("twilio");
jest.mock("../../src/networkManager");
// (<jest.Mock>twilio.webhook).mockReturnValue((req: any, res: any, next: any) => {
//     next();
// })

const webServerSettings: IWebServerSettings = {
  logDir: "/tmp",
  port: 8080
};

const ws = new WebServer(webServerSettings);

describe("twilio authenticate", () => {
  it("test the whole authentication flow", async () => {
    const twilioAgent = new TwilioAgent(
      {
        accountSid: "dummyAccountSid",
        authToken: "dummyAuthToken",
        landlinePhoneNumber: "dummyLandLinePhonNumber",
        mobilePhoneNumber: "dummyMobilePhoneNumber"
      },
      ws
    );

    (<jest.Mock>networkManager.getExternalIp).mockReturnValue(Promise.resolve("127.0.0.1"));
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [twilioAgent]);
    authSession.authState = AuthStates.STARTED;
    await twilioAgent.authenticate(authSession);
    let res = await request(ws.webapp)
      .post(`/twilio/actions/auth/${authSession.id}`)
      .send({})
      .expect("content-type", /text\/xml.*/)
      .expect(200);

    let twimlRegex = /.*Say>Hi[^<]+<\/Say><Gather action="http:\/\/[^/]+([^"]+)" [^>]+><Say>Please enter.*/;
    expect(res.text).toMatch(twimlRegex);
    let uri = res.text.match(twimlRegex)[1];

    twimlRegex = /.*Say>Authentication failed[^<]+<\/Say><Gather action="http:\/\/[^/]+([^"]+)" [^>]+><Say>Please enter.*/;
    res = await request(ws.webapp)
      .post(uri)
      .send({ Digits: "0000" })
      .expect("content-type", /text\/xml.*/)
      .expect(200);
    expect(res.text).toMatch(twimlRegex);
    uri = res.text.match(twimlRegex)[1];

    twimlRegex = /.*Say>Authentication succeeded<\/Say><Gather action="http:\/\/[^/]+([^"]+)" [^>]+><Say>Enter disarm.*/;
    res = await request(ws.webapp)
      .post(uri)
      .send({ Digits: PWD })
      .expect("content-type", /text\/xml.*/)
      .expect(200);
    expect(res.text).toMatch(twimlRegex);
    uri = res.text.match(twimlRegex)[1];

    expect(authSession.authState).toBe(AuthStates.AUTHED_WAITING_DISARM_DURATION);
    expect(authSession.tries).toBe(1);

    twimlRegex = /.*<Say>.*disarmed for an hour.*/;
    res = await request(ws.webapp)
      .post(uri)
      .send({ Digits: "14" })
      .expect("content-type", /text\/xml.*/)
      .expect(200);
    expect(res.text).toMatch(twimlRegex);
    expect(authSession.disarmDuration.asMilliseconds()).toBe(60 * 60 * 1000);
    expect(authSession.authState).toBe(AuthStates.AUTHED);
  });
});
