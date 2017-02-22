class RpicAlarmError extends Error {
  constructor (message) {
    super()
    this.message = message
    this.stack = (new Error(message)).stack
    this.name = this.constructor.name
  }
}

class AuthError extends RpicAlarmError {}
class AuthTimeoutError extends RpicAlarmError {}

class AggregatorError extends RpicAlarmError {
  constructor (errors) {
    super('AggregatorError')
    this.errors = errors
  }
}

module.exports.AuthError = AuthError
module.exports.AuthTimeoutError = AuthTimeoutError
module.exports.AggregatorError = AggregatorError
