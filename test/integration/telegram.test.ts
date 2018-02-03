import { TelegramAgent as Telegram, TelegramMessage } from "../../src/agent/telegram";
import * as TeleBot from "telebot";
import { instance as authSessionManager, AuthStates } from "../../src/authSessionManager";
import * as log4js from "log4js";

log4js.configure({
  appenders: {
    stdout: { type: "stdout" }
  },
  categories: {
    default: { appenders: ["stdout"], level: "debug" }
  }
});

jest.useFakeTimers();
jest.mock("telebot");

const TELEGRAM_CFG = {
  botName: "abotName",
  botToken: "abotToken",
  channel: "achannel",
  userId: "aUserId",
  userName: "aUsername"
};

const PWD = "dummyPwd";

function createTelegramMessage(chatId: string, text: string): TelegramMessage {
  return {
    chat: {
      id: chatId,
      title: "test",
      type: "test"
    },
    date: Date.now(),
    from: {
      first_name: "myfn",
      id: TELEGRAM_CFG.userId,
      is_bot: true,
      language_code: "en",
      last_name: "myln",
      username: "myusername"
    },
    message_id: Math.random() + Date.now(),
    text: text
  };
}

describe("authenticate", () => {
  it("send message to start a chat and send message to enter password when no chat id is present", async () => {
    const t = new Telegram(TELEGRAM_CFG, null, null);
    expect(TeleBot).toHaveBeenCalledTimes(1);

    t.start();

    const dummyMarkup = "markup";
    (<jest.Mock>TeleBot.prototype.inlineKeyboard).mockReturnValue(dummyMarkup);
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    // cheating a little bit not invoking authSession.startAuthentication that just schedules auth
    authSession.authState = AuthStates.STARTED;

    // Must send message with button to start a chat
    await t.authenticate(authSession);
    expect(TeleBot.prototype.sendMessage).toHaveBeenCalledWith(
      `@${TELEGRAM_CFG.channel}`,
      "[Alarm]",
      {
        replyMarkup: dummyMarkup
      }
    );
    // Simulate a click on url button
    await t.onMessage(createTelegramMessage(authSession.id, "/start " + authSession.id));
    expect(TeleBot.prototype.sendMessage).lastCalledWith(
      expect.anything(),
      expect.stringContaining("ntrusion detected"),
      undefined
    );
  });

  it("send intrusion message when receives a message and a chat already exists", async () => {
    const t = new Telegram(TELEGRAM_CFG, null, null);
    t.start();
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    authSession.authState = AuthStates.STARTED;
    (<any>t).chatId = "12345";
    await t.authenticate(authSession);
    expect(TeleBot.prototype.sendMessage).lastCalledWith(
      expect.anything(),
      expect.stringContaining("ntrusion detected"),
      undefined
    );
  });

  it("test the whole authentication scenario with 1 failed password attempt", async () => {
    const chatId = "12345";
    const t = new Telegram(TELEGRAM_CFG, null, null);
    t.start();
    const authSession = authSessionManager.createAuthSession(PWD, 60000, [t]);
    authSession.authState = AuthStates.STARTED;
    (<any>t).chatId = chatId;
    await t.authenticate(authSession);

    await t.onMessage(createTelegramMessage(chatId, "wrong password"));
    expect(TeleBot.prototype.sendMessage).lastCalledWith(
      expect.anything(),
      expect.stringContaining("remaining attempts 2"),
      undefined
    );
    expect(authSession.tries).toBe(1);

    await t.onMessage(createTelegramMessage(chatId, PWD));
    expect(TeleBot.prototype.sendMessage).lastCalledWith(
      expect.anything(),
      expect.stringContaining("been authenticated"),
      undefined
    );
    expect(authSession.authState).toBe(AuthStates.AUTHED_WAITING_DISARM_DURATION);

    await t.onMessage(createTelegramMessage(chatId, "1h"));
    expect(TeleBot.prototype.sendMessage).lastCalledWith(
      expect.anything(),
      expect.stringContaining("disarmed for an hour"),
      undefined
    );
    expect(authSession.disarmDuration.asMilliseconds()).toBe(60 * 60 * 1000);
    expect(authSession.authState).toBe(AuthStates.AUTHED);
  });
});
