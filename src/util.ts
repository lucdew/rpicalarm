import * as moment from "moment";

moment.relativeTimeThreshold("s", 60);
moment.relativeTimeThreshold("m", 60);
moment.relativeTimeThreshold("h", 24);

export function parseDuration(someTime: string, defaultUnit?: string) {
  const durationRegex = /^\s*([0-9]+)\s*([mMdDhHsS]*)\s*$/;
  const delayMatch = durationRegex.exec(someTime);
  if (!delayMatch) {
    throw new Error("Invalid time expression " + someTime);
  }
  return moment.duration(parseInt(delayMatch[1], 10), <moment.DurationInputArg2>(
    delayMatch[2] || defaultUnit
  ).toLowerCase());
}

export function parsePhoneDigitsDuration(digits: string) {
  if (digits.length < 2) {
    throw new Error("Invalid duration, unit is missing");
  }
  const digitToUnit: { [key: string]: string } = {
    "4": "h",
    "6": "m",
    "3": "d",
    "7": "s"
  };
  const duration = digits.slice(0, -1);
  const durationUnit = digitToUnit[digits.slice(-1, digits.length)];
  if (!durationUnit) {
    throw new Error("Invalid duration, unit not recognized");
  }
  return moment.duration(parseInt(duration), <moment.DurationInputArg2>durationUnit);
}

export function getMemberFunctionName(aFunc: (...any: any[]) => any) {
  return /([^(]+)\([^)]*\).*/.exec(aFunc.toString())[1];
}
