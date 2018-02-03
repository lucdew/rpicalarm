import {
  ITelegramConfig,
  IAuthSession,
  AuthTimeoutError,
  IAuthenticator,
  IAuthSessionEvt,
  IControlCenter
} from "../api";
import Alarm from "../alarm";
import Camera from "./camera";
import * as fs from "fs";
import * as TeleBot from "telebot";
import * as log4js from "log4js";
import { instance as authSessionManager, AuthStates } from "../authSessionManager";
import * as util from "../util";
import * as moment from "moment";

const logger = log4js.getLogger("telegramBot");
const cmdRegex = /^\/([^\s]+)\s*(.*)$/; // command example /photo <params>

export interface TelegramChat {
  id: string;
  type: string;
  title?: string;
  // others not copied
}

export interface TelegramUser {
  id: string;
  is_bot: boolean;
  first_name: string;
  last_name: string;
  username: string;
  language_code: string;
}
export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  date: number;
  chat: TelegramChat;
  text?: string;
}

const AUTH_MSG = "Intrusion detected. What is your password ?";

export class TelegramAgent implements IAuthenticator, IControlCenter {
  name = "telegram";
  delay: moment.Duration;
  private bot: TeleBot;
  private sessionId: string; // running session
  private answersExpected: { [id: string]: string } = {};
  private lastMessageSentTime: number;
  private cmdHandlers: {
    [id: string]: (message?: TelegramMessage, ...args: any[]) => Promise<any>;
  } = {};
  private lastMsgIdProcessed: number;
  private chatId: string;

  constructor(public telegramCfg: ITelegramConfig, public alarm: Alarm, public camera: Camera) {
    this.bot = new TeleBot({
      token: telegramCfg.botToken,
      polling: {
        timeout: 10
      }
    });
    for (const meth of [
      this.onDisable,
      this.onDisarm,
      this.onEnable,
      this.onPhoto,
      this.onStatus,
      this.onStart
    ]) {
      const methName = util.getMemberFunctionName(meth);
      const evtName = methName.substring(2).toLowerCase();
      this.cmdHandlers[evtName] = meth.bind(this);
      logger.debug("Added command %s with handler method %s", evtName, methName);
    }
    this.bot.on(["/*", "*"], this.onMessage.bind(this));

    // intercept sending message
    this.bot.on("sendMessage", args => {
      const id = args[0];
      const opts = args[2] || {};

      if (opts.ask) {
        this.answersExpected[id] = opts.ask;
      }
      this.lastMessageSentTime = Date.now();
    });
  }

  async start() {
    logger.debug("Starting telegram agent");

    await this.bot.connect();
    logger.debug("telegram agent started");
  }

  async onMessage(msg: TelegramMessage): Promise<any> {
    if ("" + msg.from.id !== this.telegramCfg.userId) {
      logger.debug("Unidentifed message emitter, got %j", msg.from);
      return;
    } else {
      logger.debug("Got message %j", msg);
    }
    if (this.lastMsgIdProcessed === msg.message_id) {
      logger.debug("Already processed, dropping");
      return;
    }
    this.chatId = msg.chat.id;
    this.lastMsgIdProcessed = msg.message_id;
    const cmdMatch = cmdRegex.exec(msg.text);
    let handler;

    if (cmdMatch) {
      // process control center command
      const [, cmd, cmdArgs] = cmdMatch;

      handler = this.cmdHandlers[cmd.toLowerCase()];
      if (handler) {
        try {
          await handler(msg, cmdArgs);
        } catch (err) {
          logger.error("Failed processing cmd [%s]", cmd, err);
        }
      }
    } else if (this.answersExpected[msg.chat.id]) {
      // process ask reply
      const eventType = this.answersExpected[msg.chat.id];
      delete this.answersExpected[msg.chat.id];
      handler = this.cmdHandlers[eventType];
      if (handler) {
        try {
          await handler(msg, msg.text);
        } catch (err) {
          logger.error("Failed processing chat event [%s]", eventType, err);
        }
      }
    } else if (this.sessionId) {
      // process auth session flow
      const session = authSessionManager.getSession(this.sessionId);
      if (session) {
        try {
          await this.onAuthSessionMessage(session, msg);
        } catch (err) {
          session.reportFailure(err, "telegram");
        }
      }
    }
  }

  private async sendMessage(
    text: string,
    opts?: {
      parseMode?: string;
      replyToMessage?: number;
      replyMarkup?: any;
      notification?: boolean;
      webPreview?: boolean;
      ask?: string;
    }
  ) {
    if (this.chatId) {
      return await this.bot.sendMessage(this.chatId, "[Alarm] " + text, opts);
    } else {
      throw new Error("No chat id");
    }
  }

  async onDisable() {
    try {
      this.alarm.disable();
      return await this.onStatus();
    } catch (err) {
      logger.error("could not disable alarm", err);
      return await this.sendMessage("Failed disabling alarm");
    }
  }

  async onEnable() {
    try {
      await this.alarm.enable();
      return await this.onStatus();
    } catch (err) {
      logger.error("could not enable alarm", err);
      return await this.sendMessage("failed enabling alarm");
    }
  }

  async onStatus() {
    let msg = "status:" + this.alarm.state.name;
    if (this.alarm.state === this.alarm.STATES.DISARMED) {
      msg += "\n will be enabled " + this.alarm.nextEnableDate;
    }
    return await this.sendMessage(msg);
  }

  async onStart(msg: TelegramMessage, sessionId: string) {
    if (!sessionId) {
      return this.onStatus();
    }
    const session = authSessionManager.getSession(sessionId);
    if (session) {
      try {
        await this.onAuthSessionMessage(session, msg, true);
      } catch (err) {
        session.reportFailure(err, "telegram");
      }
    } else {
      throw new Error(`session not found with ${sessionId}`);
    }
  }

  async onPhoto(msg: TelegramMessage) {
    try {
      const f = await this.camera.takePhoto();
      await this.sendMessage("sending your file...");
      await this.bot.sendPhoto(msg.chat.id, fs.createReadStream(f));
    } catch (err) {
      logger.error("failed taking photo", err);
      await this.sendMessage("failed taking photos");
    }
  }

  async onAuthSessionEvent(evt: IAuthSessionEvt) {
    if (evt.newState.isFinal()) {
      this.sessionId = undefined;
    }
    if (evt.newState === AuthStates.FAILED) {
      if (evt.err instanceof AuthTimeoutError) {
        await this.sendMessage("Authentication timed out, possible intrusion");
      } else {
        await this.sendMessage("Authentication failed, possible intrusion");
      }
    } else if (evt.newState === AuthStates.AUTHED_WAITING_DISARM_DURATION) {
      await this.sendMessage(
        "You have been authenticated. Enter disarm time, default unit is the hour"
      );
    } else if (evt.newState === AuthStates.AUTHED) {
      await this.sendMessage(
        `thanks, alarm disarmed for ${
          evt.disarmDuration ? evt.disarmDuration.humanize() : "some time"
        }`
      );
    } else if (evt.newState === AuthStates.ABORTED && evt.origin !== this.name) {
      await this.onStatus();
    }
  }

  async authenticate(session: IAuthSession) {
    logger.debug("Starting telegram authentication");

    this.sessionId = session.id;

    const sendMessageErrorHandler = (err: any) => logger.error(err);

    session.registerListener((evt: IAuthSessionEvt) => {
      this.onAuthSessionEvent(evt).catch(err => {
        logger.error(err.toString());
      });
    });
    try {
      if (!this.chatId) {
        logger.debug(
          `No chat present sending notification to ${this.telegramCfg.botName} for session ${
            session.id
          }`
        );
        const markup = this.bot.inlineKeyboard([
          [
            this.bot.inlineButton("Authenticate", {
              url: `telegram.me/${this.telegramCfg.botName}?start=${session.id}`
            })
          ]
        ]);
        logger.debug(`sending message to @${this.telegramCfg.channel}`);
        await this.bot.sendMessage(`@${this.telegramCfg.channel}`, "[Alarm]", {
          replyMarkup: markup
        });
      } else {
        await this.sendMessage(AUTH_MSG);
      }
    } catch (err) {
      session.reportFailure(err, this.name);
    }
  }

  async onAuthSessionMessage(session: IAuthSession, msg: TelegramMessage, isStart?: boolean) {
    logger.debug("session %s", session);

    const sessionUpdatedSinceLastMessage = session.lastUpdateTime > this.lastMessageSentTime;
    if (session.authState === AuthStates.STARTED && !isStart) {
      const enteredPassword = msg.text;
      if (
        !session.authenticate(enteredPassword, this.name) &&
        session.authState !== AuthStates.FAILED
      ) {
        return await this.sendMessage(
          `Wrong password,try again (remaining attempts ${session.maxTries - session.tries})`
        );
      }
    } else if (session.authState === AuthStates.STARTED) {
      return await this.sendMessage(AUTH_MSG);
    } else if (
      session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION &&
      !sessionUpdatedSinceLastMessage
    ) {
      try {
        const duration = util.parseDuration(msg.text, "h");
        session.setDisarmDuration(duration, "telegram");
        return await this.sendMessage(`thanks, alarm disarmed for ${duration.humanize()}`);
      } catch (err) {
        return await this.sendMessage("invalid disarm time, enter again");
      }
    } else {
      logger.debug("no action to be executed on session");
    }
  }

  async onDisarm(msg: TelegramMessage, disarmDurationStr: string) {
    if (disarmDurationStr && disarmDurationStr.length > 0) {
      let duration;
      try {
        duration = util.parseDuration(disarmDurationStr, "h");
      } catch (err) {
        return await this.sendMessage("invalid disarm time, enter again", {
          ask: "disarm"
        });
      }
      try {
        await this.alarm.disarm(duration);
        await this.onStatus();
      } catch (err) {
        logger.error("Failed disarming alarm", err);
        await this.sendMessage("disarm failure");
      }
    } else {
      await this.sendMessage("How long alarm must be disarmed ?", {
        ask: "disarm"
      });
    }
  }
}
