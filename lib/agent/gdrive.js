const google = require('googleapis')
const OAuth2 = google.auth.OAuth2
const logger = require('log4js').getLogger('gdrive')

/**
 * Not implemented
 */
class GdriveAgent {

  constructor ({
    client_id,
    client_secret,
    redirect_url
  }) {
    const oauth2Client = new OAuth2(
      client_id,
      client_secret,
      redirect_url
    )
    this.gdrive = google.drive({
      version: 'v3',
      auth: oauth2Client
    })
  }

  upload (f) {
    logger.debug('Uploading %s', f)
    throw new Error('Not implemented')
  }

}

GdriveAgent.supports = ['backup']
module.exports = GdriveAgent
