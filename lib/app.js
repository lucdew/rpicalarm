const fs = require('fs')
const log4js = require('log4js')
const toml = require('toml')
const yargs = require('yargs').argv

const Alarm = require('./alarm')
const Backup = require('./backup')
const cdi = require('./cdi')
const util = require('./util')
const WebServer = require('./webServer')

const logger = log4js.getLogger('rpicalarm')
logger.constructor.prototype.fatal = function () {
  this.error.apply(this, this.arguments)
  process.exit(-1)
}

function loadConf (cfgFile) {
  const cfgContent = fs.readFileSync(cfgFile).toString()
  return toml.parse(cfgContent)
}

const cfgFile = yargs.c || yargs.cfg || '/etc/rpicalarm/rpicalarm.conf'

const cfg = loadConf(cfgFile)

if (cfg.logging && cfg.logging.level) {
  log4js.setGlobalLogLevel(cfg.logging.level)
}

const factoryCtx = {}

factoryCtx.alarm = Alarm
factoryCtx.webServer = WebServer

const appCtx = cdi.buildAppCtx(cfg, factoryCtx, {
  autoDiscovery: true
})

const backupAgents = appCtx.getBySupport('backup')
const authAgents = appCtx.getBySupport('authentication')
const recordingAgents = appCtx.getBySupport('recording')
const sensorAgents = appCtx.getBySupport('sensor')
const ccs = appCtx.getBySupport('controlCenter')
const notifierAgents = appCtx.getBySupport('notification')

const alarm = appCtx.getByName('alarm')
const webServer = appCtx.getByName('webServer')

const enabledAuthAgents = []
for (const auth of (cfg.alarm.authenticators || [])) {
  const foundAg = authAgents.find(agent => agent.$name === auth.name)
  if (!foundAg) {
    logger.fatal('Invalid authenticator name %s ', auth.name)
  }
  if (auth.delay) {
    try {
      const duration = util.parseDuration(auth.delay)
      foundAg.delay = duration
    } catch (err) {
      logger.fatal('Invalid delay % for authenticator named %s', auth.delay, auth.name)
    }
  }
  enabledAuthAgents.push(foundAg)
}
alarm.authenticators = enabledAuthAgents
alarm.recorders = recordingAgents
alarm.sensors = sensorAgents
alarm.notifiers = notifierAgents

alarm.on('authenticating', () => {
  logger.debug('checking for normal presence')
})

alarm.on('intrusionDetected', () => {
  logger.info('Instrusion detected')
})

const backupClean = ({sessionId}) => backup.clean({tag: sessionId})
alarm.on('disarmed', backupClean)
alarm.on('disabled', backupClean)

const backup = new Backup(backupAgents)
for (const recordingAgent of recordingAgents) {
  backup.sync(recordingAgent.assetsSavePath)
}

for (const cc of ccs) {
  cc.start()
}
alarm.enable()
webServer.start().catch(err => {
  logger.error('Failed starting web server', err)
  process.exit(-1)
})
