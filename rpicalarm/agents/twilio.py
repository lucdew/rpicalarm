# -*- coding: utf-8 -*-

from threading import Timer

from flask import abort, request
from twilio.twiml.voice_response import VoiceResponse, Gather
from twilio.request_validator import RequestValidator
from twilio.rest import Client

from .. import events, getLogger, AuthFailureReason, AlarmState, parse_duration

LOGGER = getLogger(__name__)

GENERIC_ERROR = VoiceResponse()
GENERIC_ERROR.say("An error occurred")
GENERIC_ERROR.say("Goodbye")
GENERIC_ERROR.hangup()

DIGITS_TO_UNIT = {
    "4": "h",
    "3": "d",
    "6": "m",
    "7": "s"
}


def twilio_validation_decorate(func, token):
    def twilio_validation_decorated(*args, **kwargs):
        # Create an instance of the RequestValidator class
        validator = RequestValidator(token)

        # Validate the request using its URL, POST data,
        # and X-TWILIO-SIGNATURE header
        request_valid = validator.validate(
            request.url,
            request.form,
            request.headers.get('X-TWILIO-SIGNATURE', ''))

        # Continue processing the request if it's valid, return a 403 error if
        # it's not
        if request_valid:
            LOGGER.debug("Request is valid continuing args=%s,kwargs=%s", str(args), str(kwargs))
            return func(*args, **kwargs)
        else:
            return abort(403)
    return twilio_validation_decorated


class TwilioServer(object):

    def __init__(self, twilio_agent):
        self.alarm = twilio_agent.alarm
        self.web_server = twilio_agent.web_server
        self.twilio_agent = twilio_agent
        self.web_server.add_route(
            "/twilio/auth/<session_id>", "auth", twilio_validation_decorate(self.auth_request, self.twilio_agent.auth_token), methods=["POST"])

        self.web_server.add_route(
            "/twilio/callback/<session_id>", "callback", twilio_validation_decorate(self.callback_request, self.twilio_agent.auth_token), methods=["POST"])

    def get_gather(self, session_id):
        return Gather(action=self.get_auth_action_url(session_id),
                      timeout=30,
                      finishOnKey="#")

    def get_auth_action_url(self, session_id):
        return "{}/twilio/auth/{}".format(self.web_server.auth_base_url, session_id)

    def get_status_callback_url(self, session_id):
        return "{}/twilio/callback/{}".format(self.web_server.auth_base_url, session_id)

    def callback_request(self, session_id=None):
        session = self.alarm.current_session
        try:
            if not session:
                LOGGER.debug("Not authenticating anymore for session id is %s", session_id,)
                return ('', 200)
            elif session.id != session_id:
                LOGGER.debug("Got invalid session id %s, current session id is %s",
                             session_id, session.id)
            elif session.is_authenticated:
                self.alarm.set_disarm_time(0)
            elif not session.is_authenticated:
                events.on_authentication_failed(self.twilio_agent)
        except Exception:
            LOGGER.exception("Failed procession callback for session %s", session_id)

        return ('', 200)

    def auth_request(self, session_id=None):

        LOGGER.debug("Inside authenticated request %s", str(request.form))
        session = self.alarm.current_session
        LOGGER.debug("Session is %s", str(session))
        digits = request.form.get("Digits")
        LOGGER.debug("Got digits %s", str(digits))
        voice_response = VoiceResponse()

        if not session and self.alarm.state != AlarmState.ALARMING:
            # TODO if disarmed get enable time
            voice_response.say(
                "You already have been authenticated. current state is {}".format(self.alarm.state))
            voice_response.say("Goodbye")
            voice_response.hangup()

        elif not session:
            voice_response.say("Alarm is blaring. Goodbye.")
            voice_response.hangup()
            return str(voice_response)

        elif session.id != session_id:
            LOGGER.error("No session found for session id %s", session_id)
            voice_response = GENERIC_ERROR

        elif not session.is_authenticated and not digits:
            voice_response.say("Hi this is your alarm speaking.")
            voice_response.gather(self.get_gather(session.id)).say(
                "Please enter your password followed by the pound key.")

        elif not session.is_authenticated and digits:
            if session.authenticate(self.twilio_agent, digits):
                voice_response.say("You have been authenticated")
                voice_response.gather(self.get_gather(session.id)).say(
                    "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm.")
            else:
                if self.alarm.state != AlarmState.ALARMING:
                    voice_response.say("Authentication failed")
                    voice_response.say(
                        "You have {} tries remaining".format(session.remaining_tries))
                    voice_response.gather(self.get_gather(session.id)).say(
                        "Enter your password followed by the pound key")
                else:
                    voice_response.say("Authentication failed")
                    voice_response.say("Goodbye")
                    voice_response.hangup()

        elif session.is_authenticated and (not digits or len(digits) == 1):
            voice_response.gather(self.get_gather(session.id)).say(
                "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm.")

        elif session.is_authenticated and digits:
            try:
                unit = DIGITS_TO_UNIT[digits[-1]]
                if not unit:
                    voice_response.gather(self.get_gather(session.id)).say(
                        "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm.")
                else:
                    self.alarm.set_disarm_time(digits[:-1]+unit)
                    voice_response.say("Disarm time set for "+self.alarm.get_readable_disarm_time())
                    voice_response.hangup()

            except Exception:
                LOGGER.exception("Failed setting the disarm time")
                voice_response.gather(self.get_gather(session.id)).say(
                    "Enter disarm time, last digit is the unit followed by the pound key. Or, hang-up now to disable the alarm.")
        else:
            voice_response = GENERIC_ERROR

        return str(voice_response)


class Twilio(object):

    def __init__(self, alarm, web_server, auth_delay="0s", account_sid=None, auth_token=None, landline_phone_number=None, mobile_phone_number=None):
        self.auth_delay = parse_duration(auth_delay).total_seconds()
        self.landline_phone_number = landline_phone_number
        self.mobile_phone_number = mobile_phone_number
        self.web_server = web_server
        self.alarm = alarm
        self.client = Client(account_sid, auth_token)
        self.auth_token = auth_token

        self.twilio_server = TwilioServer(self)

        self._register_events_handlers()

        events.authenticator_started(self)

    def _register_events_handlers(self):
        events.alarm_authenticating += self.on_authentication_required

    def on_authentication_required(self, _, session):
        timer = Timer(self.auth_delay, self.trigger_authentication_call, args=[session.id])
        timer.start()

    def trigger_authentication_call(self, session_id):
        # Might check the session_id
        if not self.alarm.current_session:
            LOGGER.debug("Already authenticated, not making the call")
            return
        try:
            self.client.calls.create(
                to=self.mobile_phone_number,
                from_=self.landline_phone_number,
                url=self.twilio_server.get_auth_action_url(session_id),
                status_callback=self.twilio_server.get_status_callback_url(session_id),
                status_callback_event=["completed"]
            )
        except Exception:
            LOGGER.exception("Failed making call for authentication")
            events.authentication_failed(self, session_id, AuthFailureReason.AUTHENTICATOR_FAILURE)
