const cloudinary = require('cloudinary')
const logger = require('log4js').getLogger('cloudinary')

class CloudinaryAgent {

  constructor ({
    cloud_name,
    api_key,
    api_secret
  }) {
    cloudinary.config({
      cloud_name,
      api_key,
      api_secret
    })
  }

  upload ({
    filePath,
    metaData
  }) {
    return cloudinary.v2.uploader.upload(filePath, {
      tags: ['rpicalarm', 'rpicalarm-' + metaData.tag]
    }).then(image => {
      logger.debug('Cloudinary upload done %j', image)
      return image.secure_url
    })
  }

  clean ({
    tag
  }) {
    logger.debug('Cleaning resources of tag %s', tag)
    cloudinary.v2.api.delete_resources_by_tag('rpicalarm-' + tag)
     .then(result => {
       logger.info('Cloudinary deleting of resources of tag %s : %j', tag, result)
     })
     .catch(err => {
       logger.err('Cloudinary deleting of resources of tag %s failed', tag, err)
     })
  }

}
CloudinaryAgent.supports = ['backup']
module.exports = CloudinaryAgent
