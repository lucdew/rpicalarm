const nodemailer = require('nodemailer')
const BbPromise = require('bluebird')
const logger = require('log4js').getLogger('email')

class EmailAgent {

  constructor ({
    smtp_server_url: smtpServerUrl,
    from_email: fromEmail,
    to_email: toEmail
  }) {
    this.smtpServerUrl = smtpServerUrl
    this.transporter = nodemailer.createTransport(this.smtpServerUrl)
    this.fromEmail = fromEmail
    this.toEmail = toEmail
  }

  notify (date) {
    const mailOptions = {
      from: `${this.fromEmail}`,
      to: `${this.toEmail}`, // list of receivers
      subject: '[rpicalarm] Intrusion detected',
      text: `Intrusion detected at ${date}`,
      html: `<b>Intrusion detected at ${date}</b>`
    }

    // send mail with defined transport object
    return new BbPromise((res, rej) => {
      this.transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          return rej(err)
        }
        res()
        logger.info('Email sent %j', info)
      })
    })
  }

}

EmailAgent.supports = ['notification']
module.exports = EmailAgent
