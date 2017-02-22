const BbPromise = require('bluebird')
const twilio = require('twilio')
const logger = require('log4js').getLogger('twilio')
const authSessionManager = require('../authSessionManager')
const networkManager = require('../networkManager')
const util = require('../util')

const ROUTER_BASE_PATH = '/twilio'

class TwimlServer {

  constructor (webServer, authToken) {
    this.statusCbBasePath = '/statusCb/failure/'
    this.authActionBasePath = '/actions/auth/'
    const router = webServer.createRouter(ROUTER_BASE_PATH)
    const twilioWebHook = twilio.webhook(authToken)
    router.post(`${this.statusCbBasePath}:sessionId`, twilioWebHook, this.failedCbMiddleware.bind(this))
    router.post(`${this.authActionBasePath}:sessionId`, twilioWebHook, this.authActionMiddleware.bind(this))
    this.sessions = {}
    this.webServer = webServer
  }

  getStatusCbUrl (sessionId) {
    return networkManager.getExternalIp().then(ip => `http://${this.webServer.authUsername}:${this.webServer.authPassword}@${ip}:3000${ROUTER_BASE_PATH}${this.statusCbBasePath}${sessionId}`)
  }

  getAuthActionUrl (sessionId) {
    return networkManager.getExternalIp().then(ip => `http://${this.webServer.authUsername}:${this.webServer.authPassword}@${ip}:3000${ROUTER_BASE_PATH}${this.authActionBasePath}${sessionId}`)
  }

  failedCbMiddleware (req, res) {
    const session = authSessionManager.getSession(req.params.sessionId)
    if (session) {
      session.reportFailure(new Error('Call ended with status ' + req.body.CallStatus), 'twilio')
    }
    res.status(200).end()
  }

  sendTwiml (res, twiml) {
    const rawTwiml = twiml.toString()
    logger.debug('raw twiml ' + rawTwiml)
    res.status(200)
    res.send(rawTwiml)
  }

  authActionMiddleware (req, res) {
    logger.debug('Got req %j', req.body)
    const session = authSessionManager.getSession(req.params.sessionId)
    const twiml = new twilio.TwimlResponse()
    res.set('Content-Type', 'text/xml')
    if (!session) {
      twiml.say('Authentication failed, goodbye !')
      return this.sendTwiml(res, twiml)
    }
    logger.debug('session %s', session)

    if (session.isAuthSuccessful() && session.twilio.nextStep !== 'validateDisarmTime') { // case auth is done by other authenticator
      twiml.say('You have been authenticated, goodbye')
      return this.sendTwiml(res, twiml)
    } else if (session.isAuthAborted()) {
      twiml.say('Authentication is not required anymore')
      return this.sendTwiml(res, twiml)
    } else if (session.isAuthFailed()) {
      twiml.say('Authentication timed out')
      return this.sendTwiml(res, twiml)
    }

    this.getAuthActionUrl(req.params.sessionId)
      .then(actionUrl => {
        if (session.twilio.nextStep === 'askPassword') {
          session.twilio.nextStep = 'verifyPassword'
          twiml.say('Hi this is your rpicalarm speaking')
            .gather({
              action: actionUrl,
              timeout: 30,
              finishOnKey: '#'
            }, function () {
              this.say('Please enter your password followed by the pound key')
            })
        } else if (session.twilio.nextStep === 'validateDisarmTime') {
          try {
            const duration = util.parsePhoneDigitsDuration(req.body.Digits)
            twiml.say(`Thanks, alarm disarmed for ${duration.humanize()}`)
            session.setDisarmDuration(duration, 'twilio')
          } catch (err) {
            twiml.say(`Invalid duration`)
              .gather({
                action: actionUrl,
                timeout: 30,
                finishOnKey: '#'
              }, function () {
                this.say('enter disarm time, last digit is the unit, followed by the pound key')
              })
          }
        } else if (session.twilio.nextStep === 'verifyPassword') {
          if (!session.verify(req.body.Digits)) {
            ++session.twilio.tries
            if (session.maxTries === session.twilio.tries) {
              session.reportAuthFailure('Max tries reached', 'twilio')
              twiml.say('Maximum number of tries reached, goodbye')
            } else {
              const remainingTries = session.maxTries - session.twilio.tries
              twiml.say(`Authentication failed, you have ${remainingTries} ${remainingTries > 1 ? 'tries' : 'try'} remaining`)
                .gather({
                  action: actionUrl,
                  timeout: 30,
                  finishOnKey: '#'
                }, function () {
                  this.say('Please enter your password followed by the pound key')
                })
            }
          } else {
            session.twilio.nextStep = 'validateDisarmTime'
            session.reportAuthSuccess()
            twiml.say(`Authentication succeeded`)
              .gather({
                action: actionUrl,
                timeout: 30,
                finishOnKey: '#'
              }, function () {
                this.say('enter disarm time, last digit is the unit')
              })
          }
        }
        return this.sendTwiml(res, twiml)
      })
      .catch(err => {
        session.reportFailure(err, 'twilio')
        twiml.say(`Authentication succeeded`)
        logger.error('Failure occurred', err)
        this.sendTwiml(res, twiml)
      })
  }
}

class TwilioAgent {

  constructor ({
    account_sid: accountSid,
    auth_token: authToken,
    landline_phone_number: landlinePhoneNumber,
    mobile_phone_number: mobilePhoneNumber
  }, {
    webServer
  }) {
    this.twilioClient = twilio(accountSid, authToken)
    this.landlinePhoneNumber = landlinePhoneNumber
    this.mobilePhoneNumber = mobilePhoneNumber
    this.twimlServer = new TwimlServer(webServer, authToken)
  }

  authenticate (session) {
    logger.debug('Starting twilio authentication')
    if (session.isAuthDone()) {
      return BbPromise.resolve()
    }
    session.twilio = {
      tries: 0,
      nextStep: 'askPassword'
    }
    BbPromise.mapSeries([this.twimlServer.getAuthActionUrl, this.twimlServer.getStatusCbUrl], res => res.call(this.twimlServer, session.id))
      .then(([authActionUrl, statusUrl]) => {
        return new BbPromise((res, rej) => {
          this.twilioClient.calls.create({
            url: authActionUrl,
            to: this.mobilePhoneNumber,
            from: this.landlinePhoneNumber,
            statusCallback: statusUrl,
            statusCallbackEvent: ['busy', 'failed', 'no_answer', 'canceled']
          }, (err, call) => {
            if (err) {
              rej(err)
              return
            }
            logger.info(`Called made to [${this.mobilePhoneNumber}] from [${this.landlinePhoneNumber}] with uri [${call.uri}]`)
          })
        })
      })
      .catch(err => {
        session.reportFailure(err, 'twilio')
      })
  }
  notify (date) {
    // Not working
    // SMS requires to pay a phone number to set the from address
    return new BbPromise((res, rej) => {
      this.twilioClient.messages.create({
        to: this.mobilePhoneNumber,
        from: 'rpicalarm',
        body: '[rpicalarm] intrusion detected at ' + date
      }, (err, message) => {
        if (err) {
          return rej(err)
        }
        return res()
      })
    })
  }
}
TwilioAgent.supports = ['authentication']
TwilioAgent.$inject = ['webServer']

module.exports = TwilioAgent
