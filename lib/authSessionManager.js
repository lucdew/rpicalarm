const crypto = require('crypto')
const EventEmitter = require('events')
const errors = require('./errors')
const logger = require('log4js').getLogger('AuthSessionManager')
const moment = require('moment')

function computeDigest (salt, pwd) {
  const hash = crypto.createHash('sha256')
  hash.update(salt, 'base64')
  hash.update(pwd, 'utf-8')
  return hash.digest('hex')
}

const EVENTS = {
  authSuccess: 'authSuccess',
  authFailure: 'authFailure',
  authAbortion: 'authAbortion',
  disarmDurationSet: 'disarmDurationSet'
}

class AuthSession extends EventEmitter {

  constructor (authenticators, {
    id,
    digest,
    salt,
    authTtl = 5 * 60 * 1000,
    maxTries = 3
  }) {
    super()
    this.id = id || moment().format('YYYYMMDDHHmmssS')
    this.maxTries = maxTries
    this._authenticators = {}
    this._failures = []
    this._digest = digest
    this._salt = salt
    this._authTtl = authTtl
    this._authState = 'CREATED'

    authenticators.forEach(auth => {
      const authName = auth.$name
      this._authenticators[authName] = auth
      this[authName] = {}
    })
  }

  isAuthDone () {
    return this._authState !== 'PENDING' && this._authState !== 'CREATED'
  }

  isAuthSuccessful () {
    return this._authState === 'SUCCESS'
  }

  isAuthFailed () {
    return this._authState === 'FAILED'
  }

  isAuthAborted () {
    return this._authState === 'ABORTED'
  }

  setDisarmDuration (duration, origin) {
    this._disarmDuration = duration
    this.emit(EVENTS.disarmDurationSet, {duration, origin})
  }

  get disarmDuration () {
    return this._disarmDuration
  }

  reportAuthFailure (msg, origin) {
    this.reportFailure(new errors.AuthError(msg), origin)
  }

  reportFailure (err, origin) {
    this._failures.push(err)
    if (err instanceof errors.AuthError) {
      logger.error('Failed authentication for [%s], reason=[%s]', origin, err.message)
    } else {
      logger.error('An error occurred while authentication for [%s]', origin, err)
    }
    if (this._failures.length === Object.keys(this._authenticators).length) {
      this._fail(new errors.AggregatorError(this._failures))
    }
  }
  reportAuthSuccess (origin) {
    if (!this.isAuthDone()) {
      this._authState = 'SUCCESS'

      if (!this.disarmDuration) {
        setTimeout(() => {
          if (!this.disarmDuration) {
            this.emit(EVENTS.disarmDurationSet)
          }
        }, 60000) // wait another 1mn to have disarm duration set if not already set
      }
      this.emit(EVENTS.authSuccess, {origin})
      this._removeListeners(EVENTS.authFailure, EVENTS.authAbortion)
    }
  }

  startAuthentication () {
    setTimeout(() => {
      this._authTimeout()
    }, this._authTtl)
    this._authState = 'PENDING'
    for (const authName in this._authenticators) {
      const auth = this._authenticators[authName]
      setTimeout(() => {
        if (!this.isAuthDone()) {
          auth.authenticate(this)
        }
      }, auth.delay || 0)
    }
  }

  abort () {
    if (!this.isAuthDone()) {
      this._authState = 'ABORTED'
      this.emit(EVENTS.authAbortion)
      this._removeListeners(EVENTS.authSuccess, EVENTS.authFailure, EVENTS.disarmDurationSet)
    }
  }

  _authTimeout () {
    if (!this.isAuthDone()) {
      const authTimeoutMessage = `Authentication timeout of ${this._authTtl} ms exceeded`
      logger.error(authTimeoutMessage)
      this._fail(new errors.AuthTimeoutError(authTimeoutMessage))
    }
  }

  verify (pwd) {
    logger.debug('Password %s', pwd)
    logger.debug('Salt %s', this._salt)
    return computeDigest(this._salt, pwd) === this._digest
  }

  toString () {
    return `[id=${this.id},_authState=${this._authState},_authTtl=${this._authTtl},maxTries=${this.maxTries},_salt=${this._salt}]`
  }

  _removeListeners (...eventNames) {
    for (const eventName of eventNames) {
      this.removeAllListeners(eventName)
    }
  }

  _fail (err, reason) {
    if (!this.isAuthDone()) {
      this._authState = 'FAILED'
      this._removeListeners(EVENTS.authSuccess, EVENTS.authAbortion, EVENTS.disarmDurationSet)
      this.emit(EVENTS.authFailure, err)
    }
  }

}

class AuthSessionManager extends EventEmitter {

  constructor () {
    super()
    this.sessions = {}
  }

  createAuthSession (pwd, authTtl, authenticators) {
    const salt = crypto.randomBytes(16).toString('base64')
    const digest = computeDigest(salt, pwd)
    const authSession = new AuthSession(authenticators, {
      digest,
      salt,
      authTtl
    })
    this.sessions[authSession.id] = authSession
    setTimeout(() => {
      delete this.sessions[authSession.id]
    }, authTtl + 10 * 60 * 1000)

    return authSession
  }

  getSession (sessionId) {
    return this.sessions[sessionId]
  }

}

const authSessionManager = new AuthSessionManager()

module.exports = authSessionManager
