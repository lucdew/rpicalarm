const TeleBot = require('telebot')
const request = require('request')
const logger = require('log4js').getLogger('telegramBot')
const BbPromise = require('bluebird')
const fs = require('fs')
const sessionManager = require('../authSessionManager')
const errors = require('../errors')
const util = require('../util')
const cmdRegex = /^\/([^\s]+)\s*(.*)$/

class TelegramAgent {
  constructor ({
    bot_token: token,
    user_id: userId,
    bot_name: botName,
    channel
  }, {
    alarm,
    camera
  }) {
    this.bot = new TeleBot({
      token,
      polling: {
        timeout: 10 // Timeout in seconds for long polling. Defaults to 0, i.e. usual short polling.
                    // Should be positive, short polling should be used for testing purposes only.
      }
    })
    this.botName = botName
    this.channel = channel
    this.userId = userId
    this.sessions = {}
    this.answersExpected = {}
    this.alarm = alarm
    this.camera = camera
    const orgiPost = request.post
    request.post = function () { // dirty-hack for telebot request timeout
      if (arguments.length >= 1) {
        const options = arguments[0]
        if (options && options.url && /.*getUpdates.*/.test(options.url) && !options.timeout) {
          options.timeout = 30000
        }
        orgiPost.apply(request, arguments)
      }
    }
  }

  start () {
    logger.debug('Starting telegram agent')
    this.cmdHandlers = {}
    for (const meth of Reflect.ownKeys(Reflect.getPrototypeOf(this))) {
      if (meth.startsWith('on')) {
        const event = meth.substring(2).toLowerCase()
        this.cmdHandlers[event] = this[meth].bind(this)
        logger.debug('Added command %s with handler method %s', event, meth)
      }
    }
    this.bot.on(['/*', '*'], (msg) => {
      if (('' + msg.from.id) !== this.userId) {
        logger.debug('Unidentifed message emitter, got %j', msg.from)
        return
      } else {
        logger.debug('Got message %j', msg)
      }
      if (this.lastMsgIdProcessed === msg.message_id) {
        logger.debug('Already processed, dropping')
        return
      }
      this.chatId = msg.chat.id
      this.lastMsgIdProcessed = msg.message_id
      const cmdMatch = cmdRegex.exec(msg.text)
      let handler

      if (cmdMatch) { // process control center command
        const [, cmd, cmdArgs] = cmdMatch
        handler = this.cmdHandlers[cmd.toLowerCase()]
        if (handler) {
          handler(msg, cmdArgs).catch(err => {
            logger.error('Failed processing cmd [%s]', cmd, err)
          })
        }
      } else if (this.answersExpected[msg.chat.id]) { // process ask reply
        const eventType = this.answersExpected[msg.chat.id]
        delete this.answersExpected[msg.chat.id]
        handler = this.cmdHandlers[eventType]
        if (handler) {
          handler(msg, msg.text).catch(err => {
            logger.error('Failed processing chat event [%s]', eventType, err)
          })
        }
      } else if (this.sessions[msg.chat.id]) { // process auth session flow
        const session = sessionManager.getSession(this.sessions[msg.chat.id])
        if (session) {
          this.onAuthSessionEvent(session, msg, msg.text)
            .catch(err => {
              session.reportFailure(err, 'telegram')
            })
        }
      }
    })
    this.bot.on('sendMessage', args => {
      const id = args[0]
      const opts = args[2] || {}

      if (opts.sessionId) {
        logger.debug('id is %s', id)
        this.sessions[id] = opts.sessionId
      } else if (opts.ask) {
        this.answersExpected[id] = opts.ask
      }
    })
    this.bot.start()
    logger.debug('telegram agent started')
  }
  _sendMessage (text, opts) {
    if (this.chatId) {
      return this.bot.sendMessage(this.chatId, '[Alarm] ' + text, opts)
    } else {
      return BbPromise.reject('No chat id')
    }
  }
  onDisable () {
    try {
      this.alarm.disable()
      return this.onStatus()
    } catch (err) {
      logger.error('could not disable alarm', err)
      return this._sendMessage('Failed disabling alarm')
    }
  }
  onEnable () {
    try {
      this.alarm.enable()
      return this.onStatus()
    } catch (err) {
      logger.error('could not enable alarm', err)
      return this._sendMessage('failed enabling alarm')
    }
  }

  onStatus () {
    let msg = 'status:' + this.alarm.state.name
    if (this.alarm.state === this.alarm.STATES.DISARMED) {
      msg += '\n will be enabled ' + this.alarm.nextEnableDate
    }
    return this._sendMessage(msg)
  }

  onStart (msg, sessionId) {
    if (!sessionId) {
      return this.onStatus()
    }
    const session = sessionManager.getSession(sessionId)
    if (session) {
      return this.onAuthSessionEvent(session, msg, msg.text).catch(err => {
        session.reportFailure(err, 'telegram')
      })
    } else {
      return BbPromise.reject(`session not found with ${sessionId}`)
    }
  }

  onPhoto (msg) {
    return this.camera.takePhoto()
      .then(f => {
        return this._sendMessage('sending your file...')
            .then(() => this.bot.sendPhoto(msg.chat.id, fs.createReadStream(f)))
      },
        err => {
          logger.error('failed taking photo', err)
          return this._sendMessage('failed taking photos')
        })
  }

  authenticate (session) {
    logger.debug('Starting telegram authentication')

    const cleanSession = () => {
      delete this.sessions[session.id]
    }
    session.once('authFailure', err => {
      cleanSession()
      if (err instanceof errors.AuthTimeoutError) {
        this._sendMessage('Authentication timed out, possible intrusion')
            .catch(err => { logger.debug(err) })
      } else {
        this._sendMessage('Authentication failed, possible intrusion')
            .catch(err => { logger.debug(err) })
      }
    })
    session.once('authAbortion', cleanSession) // TODO check origin and send message if origin is not telegram

    session.once('disarmDurationSet', (evt) => {
      cleanSession()
      if (evt.origin !== 'telegram') {
        this.onStatus()
            .catch(err => { logger.debug(err) })
      }
    })

    session.telegram = {
      nextStep: 'askPassword',
      tries: 0
    }
    logger.debug('Session created')
    if (!this.chatId) {
      logger.debug(`No chat present sending notification to ${this.botName} for session ${session.id}`)
      const markup = this.bot.inlineKeyboard([
        [this.bot.inlineButton('Authenticate', {
          url: `telegram.me/${this.botName}?start=${session.id}`
        })]
      ])
      logger.debug(`sending message to @${this.channel}`)
      this.bot.sendMessage(`@${this.channel}`, '[Alarm]', {
        markup
      })
        .catch(err => {
          session.reportFailure(err, 'telegram')
        })
    } else {
      this.onAuthSessionEvent(session).catch(err => {
        session.reportFailure(err, 'telegram')
      })
    }
  }

  onAuthSessionEvent (session, msg) {
    logger.debug('session %s', session)

    if (session.isAuthSuccessful() && session.telegram.nextStep !== 'validateDisarmTime') { // case auth is done by other authenticator
      return this._sendMessage('You have been authenticated')
    } else if (session.isAuthAborted()) {
      delete this.sessions[session.id]
      return this._sendMessage('Authentication is not required anymore')
    } else if (session.isAuthFailed()) {
      delete this.sessions[session.id]
      return this._sendMessage('Authentication timed out')
    } else if (session.telegram.nextStep === 'askPassword') {
      session.telegram.nextStep = 'verifyPassword'
      return this._sendMessage('What is your password ?', {
        sessionId: session.id
      })
    } else if (session.telegram.nextStep === 'verifyPassword') {
      const enteredPassword = msg.text
      if (!session.verify(enteredPassword)) {
        ++session.telegram.tries
        if (session.maxTries === session.telegram.tries) {
          delete this.sessions[session.id]
          session.reportAuthFailure('Max failed tries reached', 'telegram')
          return this._sendMessage(`Max authentication tries reached, sorry`)
        } else {
          return this._sendMessage(`Wrong password,try again (remaining attempts ${session.maxTries - session.telegram.tries})`, {
            sessionId: session.id
          })
        }
      } else {
        session.telegram.nextStep = 'validateDisarmTime'
        session.reportAuthSuccess()
        return this._sendMessage('Enter disarm time, default unit is the hour', {
          sessionId: session.id
        })
      }
    } else if (session.telegram.nextStep === 'validateDisarmTime') {
      try {
        const duration = util.parseDuration(msg.text, 'h')
        session.setDisarmDuration(duration, 'telegram')
        return this._sendMessage(`thanks, alarm disarmed for ${duration.humanize()}`, {
          sessionId: session.id
        })
      } catch (err) {
        return this.bot.sendMessage('invalid disarm time, enter again', {
          sessionId: session.id
        })
      }
    } else {
      return BbPromise.reject(`no action to be executed on session, next step is [${session.step}]`)
    }
  }

  onDisarm (msg, cmdArgs) {
    if (cmdArgs && cmdArgs.length > 0) {
      let duration
      try {
        duration = util.parseDuration(cmdArgs, 'h')
      } catch (err) {
        return this._sendMessage('invalid disarm time, enter again', {
          ask: 'disarm'
        })
      }
      try {
        this.alarm.disarm(duration)
        return this.onStatus()
      } catch (err) {
        logger.error('Failed disarming alarm', err)
        return this._sendMessage('disarm failure')
      }
    }
    return this._sendMessage('How long alarm must be disarmed ?', {
      ask: 'disarm'
    })
  }
}

TelegramAgent.supports = ['authentication', 'controlCenter']
TelegramAgent.$inject = ['alarm', 'camera']
module.exports = TelegramAgent
