import * as api from "../api";
import * as log4js from "log4js";
//@ts-ignore
import * as cloudinary from "cloudinary";
import { config } from "bluebird";

const logger = log4js.getLogger("cloudinary");

export default class CloudinaryAgent implements api.IBackup {
  name = "cloudinary";

  constructor(cfg: api.ICloudinaryConfig) {
    cloudinary.config({
      cloud_name: cfg.cloudName,
      api_key: cfg.apiKey,
      api_secret: cfg.apiSecret
    });
  }

  async save(filePath: string, metaData: api.IBackupResourceMetadata): Promise<any> {
    const image = await cloudinary.v2.uploader.upload(filePath, {
      tags: ["rpicalarm", "rpicalarm-" + metaData.tag]
    });
    logger.debug("Cloudinary upload done %j", image);
    return image.secure_url;
  }

  async clean({ tag }: api.IBackupResourceMetadata): Promise<any> {
    logger.debug("Cleaning resources of tag %s", tag);
    try {
      const deletResult = await cloudinary.v2.api.delete_resources_by_tag("rpicalarm-" + tag);
      logger.info("Cloudinary deleting of resources of tag %s : %j", tag, deletResult);
      return deletResult;
    } catch (err) {
      logger.error("Cloudinary deleting of resources of tag %s failed", tag, err);
      throw err;
    }
  }
}
