import * as moment from "moment";

export class RpicAlarmError extends Error {
  constructor(message: string) {
    super();
    this.message = message;
    this.stack = new Error(message).stack;
    this.name = this.constructor.name;
  }
}

export class AuthError extends RpicAlarmError {}
export class AuthTimeoutError extends RpicAlarmError {}

export class AggregatorError extends RpicAlarmError {
  constructor(public errors: RpicAlarmError[]) {
    super("AggregatorError");
    this.errors = errors;
  }
}

export interface ISessionInfo {
  sessionId: string;
  intrusionDate: Date;
}

export type AuthSessionEvtName =
  | "authSuccess"
  | "authFailure"
  | "authAbortion"
  | "disarmDurationSet";

export interface IAuthSessionState {
  name: string;
  nexts: IAuthSessionState[];
  isFinal(): boolean;
}

export interface IAuthSessionEvt {
  session: IAuthSession;
  origin: string;
}

export interface IAuthSession {
  sessionId: string;
  authState: IAuthSessionState;
  lastUpdateTime: number;
  lastError: RpicAlarmError;
  lastMessage: string;
  disarmDuration?: moment.Duration;
  intrusionDate: Date;
  tries: number;
  maxTries: number;
  setDisarmDuration(duration: string, isOnlyDigits: boolean, origin: string): void;
  endInSuccess(origin: string): void;
  reportFailure(err: RpicAlarmError, origin: string, message?: string): void;
  startAuthentication(): void;
  abort(origin: string): void;
  authenticate(credential: string, origin: string): boolean;
  registerListener(listener: (evt: IAuthSessionEvt) => void): void;
  removeAllListeners(): void;
}

export interface IAgent {
  name: string;
}

export interface IRecorder extends IAgent {
  startWarningRecording(sessionInfo: ISessionInfo): Promise<any>;
  stopRecording(): Promise<any>;
}

export interface IBackupResourceMetadata {
  tag: string;
}

export interface IBackup extends IAgent {
  clean(metadata: IBackupResourceMetadata): Promise<any>;
  save(filePath: string, metadata: IBackupResourceMetadata): Promise<any>;
}

export interface INotifier extends IAgent {
  notify(sessionInfo: ISessionInfo): Promise<any>;
}

export interface IAuthenticator extends IAgent {
  authenticate(session: IAuthSession): Promise<any>;
  delay: moment.Duration;
}

export interface ISensor extends IAgent {
  start(): Promise<any>;
  stop(): Promise<any>;
}

export interface IControlCenter {
  start(): Promise<any>;
}

export interface IWebServerSettings {
  port: number;
  logDir: string;
  authUsername?: string;
  authPassword?: string;
}

export interface ILoggingSettings {
  level: "debug" | "error" | "info";
}

export interface IAlarmSettings {
  password: string;
  maxAuthTime: string;
  defaultDisarmTime: string;
  authenticators: {
    name: string;
    delay: string;
  }[];
}

export interface ICloudinaryConfig {
  apiKey: string;
  apiSecret: string;
  cloudName: string;
}

export interface ICameraSettings {
  savePath: string;
  vflip: boolean;
  hflip: boolean;
  imageSize: string;
  cameraCaptureLength: number;
  youtubeUrl: string;
  youtubeStreamKey: string;
}

export interface ITelegramConfig {
  botToken: string;
  botName: string;
  userId: string;
  userName: string;
  channel: string;
}

export interface ITwilioConfig {
  accountSid: string;
  authToken: string;
  landlinePhoneNumber: string;
  mobilePhoneNumber: string;
}

export interface IEmailConfig {
  fromEmail: string;
  toEmail: string;
  smtpServerUrl: string;
}

export interface IConfiguration {
  webServer: IWebServerSettings;
  logging: ILoggingSettings;
  alarm: IAlarmSettings;
  agents: {
    telegram: ITelegramConfig;
    twilio: ITwilioConfig;
    camera: ICameraSettings;
    cloudinary: ICloudinaryConfig;
    pirsensor: {
      pinNum: number;
    };
    email: IEmailConfig;
  };
}
