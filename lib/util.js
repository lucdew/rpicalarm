const moment = require('moment')
moment.relativeTimeThreshold('s', 60)
moment.relativeTimeThreshold('m', 60)
moment.relativeTimeThreshold('h', 24)

function parseDuration (someTime, defaultUnit) {
  const durationRegex = /^\s*([0-9]+)\s*([mMdDhHsS]*)\s*$/
  const delayMatch = durationRegex.exec(someTime)
  if (!delayMatch) {
    throw new Error('Invalid time expression ' + someTime)
  }
  return moment.duration(Number(delayMatch[1]), (delayMatch[2] || defaultUnit).toLowerCase())
}

function parsePhoneDigitsDuration (digits) {
  if (digits.length < 2) {
    throw new Error('Invalid duration, unit is missing')
  }
  const digitToUnit = {
    '4': 'h',
    '6': 'm',
    '3': 'd',
    '7': 's'
  }
  const duration = digits.slice(0, -1)
  const durationUnit = digitToUnit[digits.slice(-1, digits.length)]
  if (!durationUnit) {
    throw new Error('Invalid duration, unit not recognized')
  }
  return moment.duration(parseInt(duration), durationUnit)
}

module.exports.parseDuration = parseDuration
module.exports.parsePhoneDigitsDuration = parsePhoneDigitsDuration
