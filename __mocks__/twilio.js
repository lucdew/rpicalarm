"use strict";

jest.unmock("twilio");
const twiml = require("twilio").twiml;
const webhook = require("twilio").webhook;
jest.mock("twilio");

function twilio() {
  return {
    calls: {
      create: () => ({
        uri: "http://dummycallcreateuri/"
      })
    }
  };
}

twilio.webhook = () => {
  return (req, res, next) => {
    next();
  };
};
twilio.twiml = twiml;

module.exports = twilio;
