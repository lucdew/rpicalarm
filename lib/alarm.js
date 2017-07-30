const EventEmitter = require('events')
const BbPromise = require('bluebird')
const moment = require('moment')

const util = require('./util')
const authSessionManager = require('./authSessionManager')

const logger = require('log4js').getLogger('alarm')

const STATES = {
  DISARMED: {
    name: 'disarmed',
    get nexts () {
      return [STATES.ENABLED, STATES.DISABLED]
    }
  },
  ALARMING: {
    name: 'alarming',
    get nexts () {
      return [STATES.ENABLED, STATES.DISABLED, STATES.DISARMED]
    }
  },
  AUTHENTICATING: {
    name: 'authenticating',
    get nexts () {
      return [STATES.ENABLED, STATES.DISABLED, STATES.DISARMED]
    }
  },
  ENABLED: {
    name: 'enabled',
    get nexts () {
      return [STATES.DISABLED, STATES.DISARMED, STATES.AUTHENTICATING]
    }
  },
  DISABLED: {
    name: 'disabled',
    get nexts () {
      return [STATES.ENABLED, STATES.DISARMED]
    }
  }
}

function safeExecPromises (objs, funcName, ...args) {
  if (!objs) {
    return
  }
  const promisesToExecute = objs.map(obj => {
    if (!obj[funcName]) {
      throw new Error(`${funcName} is missing on ${typeof obj}`)
    }
    return obj[funcName].apply(obj, args).catch(err => {
      logger.error('Failed executing %s on %s', funcName, (typeof obj), err)
    })
  })
  BbPromise.each(promisesToExecute, (res, idx) => {
    logger.debug(`Executed ${funcName} on ${objs[idx].$name}`)
  })
}

class Alarm extends EventEmitter {

  constructor (cfg) {
    super()
    this.state = STATES.DISARMED
    this.authTtl = util.parseDuration(cfg.max_auth_time).asMilliseconds()
    this.defaultDisarmTtl = util.parseDuration(cfg.default_disarm_time).asMilliseconds()
    this.password = cfg.password
  }

  intrusionDetected ({sessionId}) {
    this.emit('intrusionDetected', {
      sessionId
    })
    this.state = STATES.ALARMING
    this.notifyOfIntrusion(moment().format('dddd, MMMM Do YYYY, HH:mm:ss'))
  }

  set authenticators (authenticators) {
    this._authenticators = authenticators
    logger.debug('Setting authenticators ' + this._authenticators.map(a => a.$name).join(','))
  }

  set recorders (recorders) {
    this._recorders = recorders
    logger.debug('Setting recorders ' + this._recorders.map(a => a.$name).join(','))
  }

  set sensors (sensors) {
    this._sensors = sensors
    logger.debug('Setting sensors ' + this._sensors.map(a => a.$name).join(','))
  }

  set notifiers (notifiers) {
    this._notifiers = notifiers
    logger.debug('Setting notifiers ' + this._notifiers.map(a => a.$name).join(','))
  }

  motionDetected () {
    if (!this.state.nexts.includes(STATES.AUTHENTICATING)) {
      logger.debug('Transition to [%s] state not allowed from [%s]', STATES.AUTHENTICATING.name, this.state.name)
      return
    }

    const authSession = authSessionManager.createAuthSession(this.password, this.authTtl, this._authenticators)
    this.sessionId = authSession.id

    const disableListener = () => {
      authSession.abort()
      delete this.sessionId
    }
    this.once('disabled', disableListener)

    authSession.once('authSuccess', () => {
      logger.info('Authentication succeeded')
      this.removeListener('disabled', disableListener)
      this.stopRecorders()
    })
    authSession.once('authFailure', err => {
      this.removeListener('disabled', disableListener)
      logger.debug('Auth failure error', err)
      logger.error('Failed authentication')
      delete this.sessionId
      this.intrusionDetected({sessionId: authSession.id})
    })
    authSession.once('disarmDurationSet', evt => {
      delete this.sessionId
      this.disarm({duration: evt ? evt.duration : undefined, sessionId: authSession.id})
    })
    this.state = STATES.AUTHENTICATING
    this.emit('authenticating', {
      sessionId: authSession.id
    })

    authSession.startAuthentication()
    this.startRecordersInWarning({
      sessionId: authSession.id
    })
  }

  disable () {
    this.state = STATES.DISABLED
    this.stopSensors()
    this.cancelEnableTimer()
    this.stopRecorders()
    logger.info('Alarm disabled')
    const sessionId = this.sessionId
    this.emit('disabled', {
      sessionId
    })
  }

  disarm ({duration, sessionId}) {
    this.state = STATES.DISARMED
    this.emit('disarmed', {
      sessionId
    })
    let timeout
    if (duration && duration.constructor && duration.constructor.name === 'Duration') {
      timeout = duration.asMilliseconds()
    } else if (!isNaN(duration)) {
      timeout = duration
    } else if (typeof duration === 'string') {
      try {
        timeout = util.parseDuration(duration).asMilliseconds()
      } catch (err) {
        logger.error('Received invalid duration [%s]', duration, err)
        timeout = this.defaultDisarmTtl
      }
    } else {
      timeout = this.defaultDisarmTtl
    }
    this.stopRecorders()
    this.stopSensors()
    logger.info('Alarm disarmed for roughly [%s], exact duration [%s] ', moment.duration(timeout).humanize(), timeout)
    this.scheduleEnable(timeout)
  }

  scheduleEnable (timeout) {
    this.cancelEnableTimer()
    this.enableTimer = setTimeout(() => {
      this.enable()
    }, timeout)
    this.enableTimer.nextExecutionDate = Date.now() + timeout
  }

  get nextEnableDate () {
    if (this.enableTimer) {
      return moment(this.enableTimer.nextExecutionDate).format('dddd, MMMM Do YYYY, HH:mm:ss')
    }
  }

  get STATES () {
    return STATES
  }

  cancelEnableTimer () {
    if (this.enableTimer) {
      clearTimeout(this.enableTimer)
      this.enableTimer = undefined
    }
  }

  enable () {
    this.state = STATES.ENABLED
    logger.info('Alarm enabled')
    this.cancelEnableTimer()
    this.emit('enabled')
    this.startSensors()
  }

  startSensors () {
    safeExecPromises(this._sensors, 'start')
  }

  stopSensors () {
    safeExecPromises(this._sensors, 'stop')
  }

  stopRecorders () {
    safeExecPromises(this._recorders, 'stopRecording')
  }

  startRecordersInWarning (opts) {
    safeExecPromises(this._recorders, 'startWarningRecording', opts)
  }

  notifyOfIntrusion (opts) {
    safeExecPromises(this._notifiers, 'notify', opts)
  }

}

module.exports = Alarm
