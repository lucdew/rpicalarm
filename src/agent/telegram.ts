import {
  ITelegramConfig,
  IAuthSession,
  IAuthenticator,
  IAuthSessionEvt,
  IControlCenter
} from "../api";
import Alarm from "../alarm";
import Camera from "./camera";
import Telegraf, { ContextMessageUpdate } from "telegraf";
import * as tt from "telegraf/typings/telegram-types.d";
import * as log4js from "log4js";
import { instance as authSessionManager, AuthStates } from "../authSessionManager";
import * as util from "../util";
import * as moment from "moment";

const Markup = require("telegraf/markup");

const logger = log4js.getLogger("telegramBot");
const cmdRegex = /^\/([^\s]+)\s*(.*)$/; // command example /photo <params>
const AUTH_MSG = "Intrusion detected. What is your password ?";
export class TelegramAgent implements IAuthenticator, IControlCenter {
  name = "telegram";
  delay: moment.Duration;
  private bot: Telegraf<ContextMessageUpdate>;
  private sessionId: string; // running session
  private answerExpected: string;
  private lastMessageSentTime: number;
  private cmdHandlers: {
    [id: string]: (...args: any[]) => Promise<any>;
  } = {};
  private lastMsgIdProcessed: number;
  private chatId: string;

  constructor(public telegramCfg: ITelegramConfig, public alarm: Alarm, public camera: Camera) {
    this.bot = new Telegraf(telegramCfg.botToken);

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
    this.bot.on("message", this.onMessage.bind(this));
  }

  async start() {
    logger.debug("Starting telegram agent");

    this.bot.startPolling(30);
    logger.debug("telegram agent started");
    return await Promise.resolve();
  }

  async onMessage(ctx: ContextMessageUpdate): Promise<any> {
    if (!ctx.from || "" + ctx.from.id !== this.telegramCfg.userId) {
      logger.debug("Unidentifed message emitter, got %j", ctx.from);
      return;
    } else {
      logger.debug("Got message %j", ctx.message);
    }
    if (this.lastMsgIdProcessed === ctx.message.message_id) {
      logger.debug("Already processed, dropping");
      return;
    }
    this.chatId = (ctx.chat && ctx.chat.id) + "";
    this.lastMsgIdProcessed = ctx.message.message_id;
    const cmdMatch = cmdRegex.exec(ctx.message.text);
    let handler;

    if (cmdMatch) {
      // process control center command
      const [, cmd, cmdArgs] = cmdMatch;

      handler = this.cmdHandlers[cmd.toLowerCase()];
      if (handler) {
        try {
          await handler(cmdArgs);
        } catch (err) {
          logger.error("Failed processing cmd [%s]", cmd, err);
        }
      }
    } else if (this.answerExpected) {
      // process ask reply
      const eventType = this.answerExpected;
      delete this.answerExpected;
      handler = this.cmdHandlers[eventType];
      if (handler) {
        try {
          await handler(ctx.message.text);
        } catch (err) {
          logger.error("Failed processing chat event [%s]", eventType, err);
        }
      }
    } else if (this.sessionId) {
      // process auth session flow
      const session = authSessionManager.getSession(this.sessionId);
      if (session) {
        try {
          await this.onAuthSessionMessage(session, ctx.message.text);
        } catch (err) {
          session.reportFailure(err, "telegram");
        }
      }
    }
  }

  private async sendMessage(text: string, opts?: tt.ExtraReplyMessage) {
    this.lastMessageSentTime = Date.now();
    if (this.chatId) {
      return await this.bot.telegram.sendMessage(this.chatId, "[Alarm] " + text, opts);
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

  async onStart(sessionId: string) {
    delete this.answerExpected;
    if (!sessionId) {
      return this.onStatus();
    }
    const session = authSessionManager.getSession(sessionId);
    if (session) {
      try {
        await this.onAuthSessionMessage(session, "", true);
      } catch (err) {
        session.reportFailure(err, "telegram");
      }
    } else {
      throw new Error(`session not found with ${sessionId}`);
    }
  }

  async onPhoto(ctx: ContextMessageUpdate) {
    try {
      const b = await this.camera.takePhoto();
      await this.sendMessage("sending your file...");
      logger.debug("Photo size=%s", b ? b.length + "" : "null");
      await this.bot.telegram.sendPhoto(
        this.chatId,
        { source: b },
        { caption: moment().format("YYYYMMDDHHmmss") }
      );
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
        this.chatId = `@${this.telegramCfg.channel}`;
        const startSessionMarkup = Markup.inlineKeyboard([
          [
            Markup.urlButton(
              "Authenticate",
              `telegram.me/${this.telegramCfg.botName}?start=${session.sessionId}`
            )
          ]
        ]);
        logger.debug(`sending message to @${this.telegramCfg.channel}`);
        await this.sendMessage("", {
          reply_markup: startSessionMarkup
        });
      } else {
        await this.sendMessage(AUTH_MSG);
      }
    } catch (err) {
      session.reportFailure(err, this.name);
    }
  }

  async onAuthSessionMessage(session: IAuthSession, text: string, isStart?: boolean) {
    logger.debug("session %s", session);

    const sessionUpdatedSinceLastMessage = session.lastUpdateTime > this.lastMessageSentTime;
    if (session.authState === AuthStates.STARTED && !isStart) {
      const enteredPassword = text;
      session.authenticate(enteredPassword, this.name);
    } else if (session.authState === AuthStates.STARTED && isStart) {
      return await this.sendMessage(AUTH_MSG);
    } else if (
      session.authState === AuthStates.AUTHED_WAITING_DISARM_DURATION &&
      !sessionUpdatedSinceLastMessage // if session has been updated it means that the msg.txt is the password, ignore it it is not required anymore
    ) {
      try {
        session.setDisarmDuration(text, false, "telegram");
      } catch (err) {
        // ignore
      }
    } else {
      logger.debug("no action to be executed on session");
    }
  }

  async onDisarm(disarmDurationStr: string) {
    if (disarmDurationStr && disarmDurationStr.length > 0) {
      let duration;
      try {
        duration = util.parseDuration(disarmDurationStr, "h");
      } catch (err) {
        this.answerExpected = "disarm";
        return await this.sendMessage("invalid disarm time, enter again");
      }
      try {
        await this.alarm.disarm(duration);
        await this.onStatus();
      } catch (err) {
        logger.error("Failed disarming alarm", err);
        await this.sendMessage("disarm failure");
      }
    } else {
      this.answerExpected = "disarm";
      await this.sendMessage("How long alarm must be disarmed ?");
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
