import * as nodemailer from "nodemailer";
import * as log4js from "log4js";
import * as api from "../api";
import { IEmailConfig } from "../api";

const logger = log4js.getLogger("email");

export default class EmailAgent implements api.INotifier {
  name = "email";
  transporter: nodemailer.Transporter;

  constructor(public config: IEmailConfig) {
    this.transporter = nodemailer.createTransport(this.config.smtpServerUrl);
  }

  async notify(sessionInfo: api.ISessionInfo) {
    const mailOptions = {
      from: `${this.config.fromEmail}`,
      to: `${this.config.toEmail}`, // list of receivers
      subject: "[rpicalarm] Intrusion detected",
      text: `Intrusion detected at ${sessionInfo.intrusionDate}`,
      html: `<b>Intrusion detected at ${sessionInfo.intrusionDate}</b>`
    };

    // send mail with defined transport object

    const sentInfo = await this.transporter.sendMail(mailOptions);
    logger.info("Email sent %j", sentInfo);
  }
}
