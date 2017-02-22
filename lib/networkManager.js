const http = require('http')
const logger = require('log4js').getLogger('networkManager')
const BbPromise = require('bluebird')

let lastQueriedIpTime
let externalIp

function _getIpInfo (cb) {
  return new BbPromise((res, rej) => {
    http.get('http://ipinfo.io', (resp) => {
      const statusCode = res.statusCode
      if (statusCode >= 300) {
        resp.resume()
        return rej(new Error('Failed request, got http status ' + statusCode))
      }
      resp.on('error', err => {
        rej(err)
      })
      let rawData = ''
      resp.on('data', chunk => {
        rawData += chunk
      })
      resp.on('end', () => {
        res(rawData)
      })
    })
  })
}

function getExternalIp () {
  if (!externalIp || Date.now() - lastQueriedIpTime > 2000) {
    logger.debug('Refreshing external ip')
    return _getIpInfo()
      .then(res => {
        externalIp = JSON.parse(res).ip
        lastQueriedIpTime = Date.now()
        logger.debug('New ip is [%s]', externalIp)
        return externalIp
      })
  }
  return BbPromise.resolve(externalIp)
}

module.exports.getExternalIp = getExternalIp
