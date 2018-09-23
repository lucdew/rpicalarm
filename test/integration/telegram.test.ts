import { TelegramAgent } from "../../src/agent/telegram";
import { instance as authSessionManager, AuthStates } from "../../src/authSessionManager";
import * as log4js from "log4js";
import { ContextMessageUpdate } from "telegraf";

const Telegraf = require("telegraf");

log4js.configure({
  appenders: {
    stdout: { type: "stdout" }
  },
  categories: {
    default: { appenders: ["stdout"], level: "debug" }
  }
});

jest.useFakeTimers();
jest.mock("telegraf");

const TELEGRAM_CFG = {
  botName: "abotName",
  botToken: "abotToken",
  channel: "achannel",
  userId: "1234",
  userName: "aUsername"
};

const PWD = "dummyPwd";

function createContextMessageUpdate(chatId: string, text: string): ContextMessageUpdate {
  return <ContextMessageUpdate>{
    chat: {
      id: Number(chatId),
      title: "test",
      type: "test"
    },
    from: {
      first_name: "myfn",
      id: Number(TELEGRAM_CFG.userId),
      is_bot: true,
      language_code: "en",
      last_name: "myln",
      username: "myusername"
    },
    message: {
      message_id: Math.random() + Date.now(),
      text,
      date: Date.now(),
      chat: {
        id: Number(chatId),
        title: "test",
        type: "test"
      }
    }
  };
}

beforeEach(() => {
  // Clear all instances and calls to constructor and all methods:
  Telegraf.sendMessageMock.mockClear();
  Telegraf.default.mockClear();
});

describe("authenticate", () => {
  it("send message to start a chat and send message to enter password when no chat id is present", async () => {
    const t = new TelegramAgent(TELEGRAM_CFG, null, null);
    expect(Telegraf.default).toHaveBeenCalledTimes(1);

    await t.start();

    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    // cheating a little bit not invoking authSession.startAuthentication that just schedules auth
    authSession.authState = AuthStates.STARTED;

    // Must send message with button to start a chat
    await t.authenticate(authSession);
    expect(Telegraf.sendMessageMock).toHaveBeenCalledWith(`@${TELEGRAM_CFG.channel}`, "[Alarm] ", {
      reply_markup: expect.anything()
    });
    // Simulate a click on url button

    await t.onMessage(
      createContextMessageUpdate(authSession.sessionId, "/start " + authSession.sessionId)
    );
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("ntrusion detected"),
      undefined
    );
  });

  it("send intrusion message when receives a message and a chat already exists", async () => {
    const t = new TelegramAgent(TELEGRAM_CFG, null, null);

    await t.start();
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    authSession.authState = AuthStates.STARTED;
    (<any>t).chatId = "12345";
    await t.authenticate(authSession);
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("ntrusion detected"),
      undefined
    );
  });

  it("test the whole authentication scenario with 1 failed password attempt and 1 wrong disarm duration", async () => {
    const chatId = "12345";
    const t = new TelegramAgent(TELEGRAM_CFG, null, null);
    await t.start();
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    authSession.authState = AuthStates.STARTED;
    (<any>t).chatId = chatId;
    await t.authenticate(authSession);

    await t.onMessage(createContextMessageUpdate(chatId, "wrong password"));
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("2 tries remaining"),
      undefined
    );
    expect(authSession.tries).toBe(1);

    await t.onMessage(createContextMessageUpdate(chatId, PWD));
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("been authenticated. Enter the disarm time"),
      undefined
    );
    expect(authSession.authState).toBe(AuthStates.AUTHED_WAITING_DISARM_DURATION);

    await t.onMessage(createContextMessageUpdate(chatId, "dummy"));
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("nvalid disarm duration"),
      undefined
    );

    expect(authSession.authState).toBe(AuthStates.AUTHED_WAITING_DISARM_DURATION);

    await t.onMessage(createContextMessageUpdate(chatId, "2h"));
    expect(Telegraf.sendMessageMock).lastCalledWith(
      expect.anything(),
      expect.stringContaining("disarmed for 2 hours"),
      undefined
    );
    expect(authSession.disarmDuration.asMilliseconds()).toBe(2 * 60 * 60 * 1000);
    expect(authSession.authState).toBe(AuthStates.AUTHED);
  });

  it("test that setting a disarm duration of 0 is valid ", async () => {
    const chatId = "12345";
    const t = new TelegramAgent(TELEGRAM_CFG, null, null);
    await t.start();
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    authSession.authState = AuthStates.STARTED;
    (<any>t).chatId = chatId;
    await t.authenticate(authSession);

    await t.onMessage(createContextMessageUpdate(chatId, PWD));
    expect(authSession.authState).toBe(AuthStates.AUTHED_WAITING_DISARM_DURATION);

    await t.onMessage(createContextMessageUpdate(chatId, "0"));
    expect(authSession.authState).toBe(AuthStates.AUTHED);
  });
});
