import * as fs from "fs";
import * as path from "path";
import * as moment from "moment";
import * as bluebird from "bluebird";
import * as log4js from "log4js";
import { IBackup } from "./api";

const logger = log4js.getLogger("backup");

function isImageFile(f: string) {
  return f && !path.basename(f).startsWith("_") && (f.endsWith(".jpeg") || f.endsWith(".jpg"));
}

const fsAccessAsync = bluebird.promisify(fs.access);
const fsReaddirAsync = bluebird.promisify(fs.readdir);

export default class Backup {
  private watchers: { [name: string]: fs.FSWatcher } = {};
  private fileQueue: string[] = [];
  private syncDirs: string[] = [];
  private isConsuming = false;

  constructor(public backends: IBackup[]) {
    logger.debug("Setting backends " + backends.map(a => a.name).join(","));
  }

  sync(aDir: string) {
    this.syncDirs.push(aDir);
    fs.readdir(aDir, (err, files) => {
      if (err) {
        logger.error("Failed listing dir %s", aDir, err);
        return;
      }

      this.uploadFiles(files.filter(isImageFile).map(f => path.join(aDir, f)));
    });

    const dirWatcher = fs.watch(
      aDir,
      {
        persistent: true
      },
      (eventType, fileName) => {
        if (eventType === "rename") {
          const filePath = path.join(aDir, fileName);
          fs.stat(filePath, err => {
            if (err) {
              return;
            }
            if (!isImageFile(filePath)) {
              return;
            }
            // TODO check if file size has changed
            this.uploadFiles([filePath]);
          });
        }
      }
    );

    dirWatcher.on("error", err => {
      logger.error("Failed watching %s", aDir, err);
      delete this.watchers[aDir];
    });

    this.watchers[aDir] = dirWatcher;
  }

  private uploadFiles(someFiles: string[]) {
    if (someFiles.length === 0) {
      return;
    }
    for (const f of someFiles) {
      logger.debug("Adding %s in queue", f);
      this.fileQueue.push(f);
    }
    this.consumeFileQueue();
  }

  private getFileMetaData(f: string) {
    const felts = path.parse(f).name.split("_");
    let creationDate;
    if (felts.length > 1) {
      try {
        creationDate = moment(parseInt(felts[1]) * 1000).local();
      } catch (err) {
        logger.error("Invalid file date format %s", felts[1]);
      }
    }
    return {
      tag: felts[0],
      creationDate
    };
  }

  private async backendsUpload(someFiles: string[]): Promise<any> {
    for (let idx = 0; idx < someFiles.length; idx++) {
      const f = someFiles[idx];
      try {
        await fsAccessAsync(f);
      } catch (err) {
        logger.error("Failed accessing file %s must have been deleted", f, err);
        return;
      }
      logger.debug("Uploading file %s", f);
      try {
        await bluebird.any(this.backends.map(b => b.save(f, this.getFileMetaData(f))));
        logger.info("Backed up file %s", f);
        fs.unlink(f, unlinkErr => {
          if (unlinkErr) {
            logger.error("Failed deleting file %s", f, unlinkErr);
          }
        });
      } catch (uploadErr) {
        logger.error("Failed uploading files", uploadErr);
        someFiles.splice(idx, 1); // remove it to process it once again
      }
    }
  }

  private async doConsumeFileQueue() {
    this.isConsuming = true;
    const queueCopy = this.fileQueue.slice();

    await this.backendsUpload(queueCopy); // it removes unprocessed files
    this.fileQueue = this.fileQueue.filter(x => !queueCopy.includes(x));
    this.isConsuming = false;
    if (this.fileQueue.length > 0) {
      logger.debug("File queue length", this.fileQueue.length);
      setImmediate(() => this.consumeFileQueue());
    } else {
      logger.debug("No more files to process");
    }
  }

  private consumeFileQueue() {
    if (this.isConsuming) {
      logger.debug("Already consuming");
      return;
    }

    this.doConsumeFileQueue().catch(err => {
      logger.error("Unexpected error", err);
    });
  }

  clean(tag: string) {
    logger.debug("cleaning " + tag);
    if (!tag) {
      return;
    }

    Promise.all(this.syncDirs.map(aDir => this.cleanDir(aDir, tag))).catch(err => {
      logger.error("Unexpected error cleaning resource of tag %s", tag, err);
    });
  }

  private async cleanDir(aDir: string, tag: string): Promise<any> {
    const metaFileFilter = (f: string) => {
      const meta = this.getFileMetaData(f);
      return meta.tag === tag;
    };
    const files = await fsReaddirAsync(aDir);
    for (const f of files.filter(metaFileFilter)) {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        logger.error("Failure on cleaning file %s of tag %s", f, tag, err);
      }
    }
    this.fileQueue = this.fileQueue.filter(f => !metaFileFilter(f));
    for (const backend of this.backends) {
      await backend.clean({ tag });
    }
  }
}
