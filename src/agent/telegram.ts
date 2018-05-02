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
const request = require("request");

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
        timeout: 30
      }
    });

    // dirty-hack for telebot request timeout
    const orgiPost = request.post;
    request.post = function() {
      if (arguments.length >= 1) {
        const options = arguments[0];
        if (options && options.url && /.*getUpdates.*/.test(options.url) && !options.timeout) {
          options.timeout = 180000; // 3mn safeguard in cases the telegram long polling timeout is not applied
          return orgiPost.apply(request, arguments);
        }
      }
      return orgiPost.apply(request, arguments);
    };

    for (const meth of [
      this.onDisable,
      this.onDisarm,
      this.onEnable,
      this.onPhoto,
      this.onStatus,
      this.onStart,
      this.onCam,
      this.onCamStatus
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
      const isAuthSessionRunning = !!this.sessionId;
      await this.alarm.disable(this.name);
      if (!isAuthSessionRunning) {
        return await this.onStatus();
      }
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

  async onStatus(msg?: string) {
    let txtMsg;
    if (msg) {
      txtMsg = msg + "\n";
    }
    // TODO: remove check for testing (avoiding to instantiate an alarm)
    if (this.alarm) {
      txtMsg = "status:" + this.alarm.state.name;
      if (this.alarm.state === this.alarm.STATES.DISARMED) {
        txtMsg += "\n will be enabled " + this.alarm.nextEnableDate;
      }
    }
    return await this.sendMessage(txtMsg);
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
      const b = await this.camera.takePhoto();
      await this.sendMessage("sending your file...");
      logger.debug("Photo size=%s", b ? b.length + "" : "null");
      await this.bot.sendPhoto(msg.chat.id, b, {
        fileName: moment().format("YYYYMMDDHHmmss")
      });
    } catch (err) {
      logger.error("failed taking photo", err);
      await this.sendMessage("failed taking photos");
    }
  }

  async onAuthSessionEvent(evt: IAuthSessionEvt) {
    const session = evt.session;
    const authState = evt.session.authState;

    if (authState.isFinal()) {
      this.sessionId = undefined;
      await this.onStatus(session.lastMessage);
    } else if (
      authState === AuthStates.AUTHED_WAITING_DISARM_DURATION &&
      (!session.lastError || (evt.origin === this.name && session.lastError)) // ignore error message of other authenticators
    ) {
      await this.sendMessage(
        session.lastMessage +
          " Enter the disarm time (ex: 4h for 4 hours) or just type 0 to disable the alarm."
      );
    } else if (authState === AuthStates.STARTED && session.tries > 0 && evt.origin === this.name) {
      await this.sendMessage(session.lastMessage);
    }
  }

  async authenticate(session: IAuthSession) {
    logger.debug("Starting telegram authentication");

    this.sessionId = session.sessionId;

    const sendMessageErrorHandler = (err: any) => logger.error(err);

    session.registerListener(async (evt: IAuthSessionEvt) => {
      try {
        await this.onAuthSessionEvent(evt);
      } catch (err) {
        logger.error(err);
      }
    });
    try {
      if (!this.chatId) {
        logger.debug(
          `No chat present sending notification to ${this.telegramCfg.botName} for session ${
            session.sessionId
          }`
        );
        const markup = this.bot.inlineKeyboard([
          [
            this.bot.inlineButton("Authenticate", {
              url: `telegram.me/${this.telegramCfg.botName}?start=${session.sessionId}`
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
      session.authenticate(enteredPassword, this.name);
    } else if (session.authState === AuthStates.STARTED && isStart) {
      return await this.sendMessage(AUTH_MSG);
    } else if (
      session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION &&
      !sessionUpdatedSinceLastMessage // if session has been updated it means that the msg.txt is the password, ignore it it is not required anymore
    ) {
      try {
        session.setDisarmDuration(msg.text, false, "telegram");
      } catch (err) {
        // ignore
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

  async onCam() {
    try {
      const hasStarted = await this.camera.toggleWebCam();
      if (hasStarted) {
        return await this.sendMessage(
          "Live stream started, check out https://www.youtube.com/live_dashboard"
        );
      } else {
        return await this.sendMessage("Live stream stopped");
      }
    } catch (err) {
      logger.error("failed executing webcam operation ", err);
      await this.sendMessage("webcam command failed");
    }
  }

  async onCamStatus() {
    try {
      const status = await this.camera.getStatus();
      return await this.sendMessage("camera is " + status);
    } catch (err) {
      logger.error("failed getting camera status", err);
      await this.sendMessage("Could not get camera status, reason=" + err.message);
    }
  }
}
