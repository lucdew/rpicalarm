const BbPromise = require('bluebird')
const bodyParser = require('body-parser')
const express = require('express')
const FileStreamRotator = require('file-stream-rotator')
const fs = require('fs')
const http = require('http')
const logger = require('log4js').getLogger('webServer')
const morgan = require('morgan')
const path = require('path')
const passport = require('passport')
const Strategy = require('passport-http').DigestStrategy

class WebServer {

  constructor ({
    port,
    log_dir: logDir,
    auth_username: authUsername,
    auth_password: authPassword
  }) {
    this.port = port
    this.logDir = logDir
    this.authUsername = authUsername
    this.authPassword = authPassword
    this._init()
  }
  _init () {
    fs.existsSync(this.logDir) || fs.mkdirSync(this.logDir)

    const accessLogStream = FileStreamRotator.getStream({
      date_format: 'YYYYMMDD',
      filename: path.join(this.logDir, 'access-%DATE%.log'),
      frequency: 'daily',
      verbose: false
    })

    passport.use(new Strategy({
      qop: 'auth'
    },
      (username, cb) => {
        if (this.authUsername !== username) {
          return cb(null, false)
        }
        return cb(null, this.authUsername, this.authPassword)
      }))

    const webapp = express()
    webapp.disable('x-powered-by')
    webapp.set('port', process.env.PORT || this.port)
    webapp.use(bodyParser.urlencoded({
      extended: true
    }))
    webapp.use(bodyParser.json({
      limit: '500kb'
    }))
    morgan.token('headers', function (req, res) {
      const headers = []
      for (const hName in req.headers) {
        headers.push(`${hName}=${req.headers[hName]}`)
      }
      return `headers[${headers.join(',')}]`
    })
    webapp.use(morgan('remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" ":headers"', {
      stream: accessLogStream
    }))
    webapp.use(passport.authenticate('digest', {
      session: false
    }))
    this.webapp = webapp
    this.httpServer = http.createServer(webapp)
  }
  createRouter (path) {
    const router = express.Router()
    this.webapp.use(path, router)
    return router
  }
  start () {
    return new BbPromise((res, rej) => {
      this.httpServer.on('error', err => rej(err))
      const port = this.webapp.get('port')
      this.httpServer.listen(port, () => {
        logger.info('Web server listening on port ' + port)
        return res()
      })
    })
  }
  stop () {
    this.httpServer.close()
  }
}

module.exports = WebServer
