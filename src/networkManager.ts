import * as http from "http";
import * as log4js from "log4js";

const logger = log4js.getLogger("networkManager");

let lastQueriedIpTime: number;
let externalIp: string;

function _getIpInfo(): Promise<string> {
  return new Promise((res, rej) => {
    http.get("http://ipinfo.io", resp => {
      const statusCode = resp.statusCode;
      if (statusCode >= 300) {
        resp.resume();
        return rej(new Error("Failed request, got http status " + statusCode));
      }
      resp.on("error", err => {
        rej(err);
      });
      let rawData = "";
      resp.on("data", chunk => {
        rawData += chunk;
      });
      resp.on("end", () => {
        res(rawData);
      });
    });
  });
}

export async function getExternalIp() {
  if (!externalIp || Date.now() - lastQueriedIpTime > 2000) {
    logger.debug("Refreshing external ip");
    const ipInfoRes = await _getIpInfo();
    externalIp = JSON.parse(ipInfoRes).ip;
    lastQueriedIpTime = Date.now();
    logger.debug("New ip is [%s]", externalIp);
    return externalIp;
  }
  return externalIp;
}
