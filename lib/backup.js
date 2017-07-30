const fs = require('fs')
const path = require('path')
// const mime = require('mime-types')
const moment = require('moment')
const BbPromise = require('bluebird')
const logger = require('log4js').getLogger('cloudbackup')

function isImageFile (f) {
  return f && (f.endsWith('.jpeg') || f.endsWith('.jpg'))
}

const fsAccessAsync = BbPromise.promisify(fs.access)
const fsReaddirAsync = BbPromise.promisify(fs.readdir)

class Backup {

  constructor (backends) {
    this.watchers = {}
    this.fileQueue = []
    this.backends = backends
    this.syncDirs = []
    logger.debug('Setting backends ' + backends.map(a => a.$name).join(','))
  }

  sync (aDir) {
    this.syncDirs.push(aDir)
    fs.readdir(aDir, (err, files) => {
      if (err) {
        logger.error('Failed listing dir %s', aDir, err)
        return
      }

      this.uploadFiles(files.filter(isImageFile).map(f => path.join(aDir, f)))
    })

    const dirWatcher = fs.watch(aDir, {
      persistent: true
    }, (eventType, fileName) => {
      if (eventType === 'rename') {
        const filePath = path.join(aDir, fileName)
        fs.stat(filePath, err => {
          if (err) {
            return
          }
          if (!isImageFile(filePath)) {
            return
          }
          // TODO check if file size has changed
          this.uploadFiles([filePath])
        })
      }
    })

    dirWatcher.on('error', err => {
      logger.error('Failed watching %s', aDir, err)
      delete this.watchers[aDir]
    })

    this.watchers[aDir] = dirWatcher
  }

  uploadFiles (someFiles) {
    if (someFiles.length === 0) {
      return
    }
    for (const f of someFiles) {
      logger.debug('Adding %s in queue', f)
      this.fileQueue.push(f)
    }
    this.consumeFileQueue()
  }

  getFileMetaData (f) {
    const felts = path.parse(f).name.split('_')
    let creationDate
    if (felts.length > 1) {
      try {
        creationDate = moment(parseInt(felts[1]) * 1000).local()
      } catch (err) {
        logger.error('Invalid file date format %s', felts[1])
      }
    }
    return {
      tag: felts[0],
      creationDate
    }
  }

  consumeFileQueue () {
    if (this.isConsuming) {
      logger.debug('Already consuming')
      return
    }
    this.isConsuming = true
    const queueCopy = this.fileQueue.slice()
    const self = this
    BbPromise.mapSeries(queueCopy, (f, idx) => {
      return fsAccessAsync(f)
        .then(function onFulfilled () {
          logger.debug('Uploading file %s', f)
          return BbPromise.any(self.backends.map(backend => backend.upload({
            filePath: f,
            metaData: self.getFileMetaData(f)
          })))
            .then((res) => {
              logger.info('Backed up file %s', f)
              fs.unlink(f)
              return BbPromise.resolve(f)
            })
            .catch(err => {
              logger.error('Failed uploading files', err)
              queueCopy.splice(idx, 1) // remove it to process it once again
            })
        }, function onReject (err) {
          logger.error('Failed accessing file %s must have been deleted', f, err)
        })
    })
    .then(() => {
      self.fileQueue = self.fileQueue.filter(x => !queueCopy.includes(x))
      self.isConsuming = false
      if (this.fileQueue.length > 0) {
        logger.debug('File queue length', this.fileQueue.length)
        setImmediate(() => self.consumeFileQueue())
      } else {
        logger.debug('No more files to process')
      }
      return BbPromise.resolve('done')
    })
    .done()
  }

  clean ({
    tag
  }) {
    logger.debug('cleaning ' + tag)
    if (!tag) {
      return
    }
    const metaFileFilter = f => {
      const meta = this.getFileMetaData(f)
      return meta.tag === tag
    }
    BbPromise.all(this.syncDirs, aDir =>
      fsReaddirAsync(aDir)
      .then(files => {
        for (const f of files.filter(metaFileFilter)) {
          try {
            fs.unlinkSync(f)
          } catch (err) {
            logger.error('Failure on cleaning file %s of tag %s', f, tag, err)
          }
        }
      })
    )
    .then(() => {
      this.fileQueue = this.fileQueue.filter(f => !metaFileFilter(f))
    })
    .then(() => {
      for (const backend of this.backends) {
        backend.clean({tag})
      }
    })
    .catch(err => {
      logger.error('Unexpected error cleaning resource of tag %s', tag, err)
    })
  }
}
module.exports = Backup
