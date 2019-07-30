# -*- coding: utf-8 -*-
import logging
import datetime

from telegram import Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Updater, CommandHandler, RegexHandler, DispatcherHandlerStop, ConversationHandler

from rpicalarm.util import getLogger
from .. import events, run_async, AuthFailureReason, AlarmState

LOGGER = getLogger(__name__)
getLogger("telegram").setLevel(logging.ERROR)

AUTH_MSG = "Intrusion detected. What is your password ?"

CONV_AUTH, CONV_SET_DISARM_TIME = range(2)


class Telegram(object):
    """
    Performs end-user interaction.
    """

    def __init__(self, alarm, camera, **cfg):
        self.bot_name = cfg["bot_name"]
        self.user_id = int(cfg["user_id"])
        self.user_name = cfg["user_name"]
        self.channel = cfg["channel"]
        self.bot = Bot(cfg["bot_token"])
        self.alarm = alarm
        self.camera = camera
        self.chat_id = None
        self.session = None
        self.conv_handler = None
        self._start()
        self._register_events_handlers()

        events.authenticator_started(self)

    def _register_events_handlers(self):
        events.authentication_succeeded += self.on_authentication_successful
        events.authentication_ended += self.on_authentication_ended
        events.authentication_failed += self.on_authentication_failed
        events.alarm_authenticating += self.on_authentication_required
        events.alarm_alarming += self._send_status
        events.alarm_disabled += self._send_status
        events.alarm_disarmed += self._send_status
        events.alarm_armed += self._send_status

    def handle_save_chat_id(self, _, update):
        from_user_id = update.message.from_user.id
        if from_user_id != self.user_id:
            LOGGER.debug("Received unauthenticated message from user %s", from_user_id)
            raise DispatcherHandlerStop("Unauthenticated message")
        self.chat_id = update.message.chat_id
        LOGGER.debug("Set Telegram chat_id %s", update.message.chat_id)

    def handle_debug(self, _, update):
        LOGGER.debug("Received Telegram bot message: %s", update.message.text)

    def handle_get_status(self, *_):
        msg = "status: {0}".format(self.alarm.state)
        if self.alarm.state == AlarmState.DISARMED:
            msg += "\nWill be re-armed in {0}".format(self.alarm.get_readable_disarm_time())
        self._send_message(msg)

    def handle_take_photo(self, *_):
        photo = None
        try:
            with self.camera.take_photo_io() as photo:
                self._send_message("sending your file...")
                self.bot.send_photo(self.chat_id, photo, timeout= 60,
                                    caption=datetime.datetime.now().strftime('%H:%M:%S %d/%m/%Y'))
        except Exception:
            LOGGER.exception("Failed taking photo")
            self._send_message("Failed taking photo")

    def handle_enable(self, *_):
        self._update_state(AlarmState.ARMED)

    def handle_disable(self, *_):
        self.session = None
        self._update_state(AlarmState.DISABLED)

    def handle_auth_update(self, _, update):
        LOGGER.debug("auth update %s", repr(update))
        session = self.session
        if session is None:
            LOGGER.debug("No session found ending conversation")
            return ConversationHandler.END

        if session.authenticate(self, update.message.text):
            LOGGER.debug("Ending auth conversation")
            return CONV_SET_DISARM_TIME
        else:
            self._send_message("Authentication failed. {0} tries remaining".format(
                session.remaining_tries))
            return None if self.alarm.state == AlarmState.AUTHENTICATING else ConversationHandler.END

    def handle_disarm_update(self, _, update):
        try:
            self.alarm.set_disarm_time(update.message.text.strip())
            return ConversationHandler.END
        except Exception:
            LOGGER.exception("Could not set disarm time")
            self._send_message("Invalid duration format")
            return None

    def handle_cam(self, *_):
        try:
            if self.camera.toggle_web_stream():
                self._send_message(
                    "Live stream started, check out https://www.youtube.com/live_dashboard")
            else:
                self._send_message("Live stream stopped")
        except Exception:
            LOGGER.exception("Failed toggling camera")
            self._send_message("Toggling camera failed")

    def handle_cam_status(self, *_):
        LOGGER.debug("Executing handle_cam_status")
        try:
            status = self.camera.get_state()
            self._send_message("Camera is {}".format(status))
        except Exception:
            LOGGER.exception("Failed getting camera status")
            self._send_message("Getting status failed")

    def _update_state(self, new_state):
        try:
            self.alarm.update_state(new_state)
        except Exception:
            LOGGER.exception("Failed updating state to %s", new_state)
            self._send_message("Failed updating state, current state is %s", self.alarm.state)

    def _get_conv_key(self):
        return (self.chat_id,)

    def _authenticate(self, session):
        try:
            if not self.chat_id:
                self.chat_id = "@{0}".format(self.channel)
                LOGGER.debug("No chat id present, sending invite to join to chat")
                mark_up = InlineKeyboardMarkup([[InlineKeyboardButton(
                    text="Authenticate", url="telegram.me/{0}?start={1}".format(self.bot_name, session.id))]])
                self._send_message("", reply_markup=mark_up)
            else:
                self.conv_handler.update_state(CONV_AUTH, self._get_conv_key())
                self._send_message(AUTH_MSG)
        except Exception:
            events.authentication_failed(self, session, AuthFailureReason.AUTHENTICATOR_FAILURE)
            LOGGER.exception("Failed sending authentication message")

    @run_async
    def _send_status(self, *_):
        if self.chat_id is not None and self.bot is not None:
            self.handle_get_status()

    @run_async
    def _send_message_async(self, *args, **kwargs):
        return self._send_message(*args, **kwargs)

    def _send_message(self, text, reply_markup=None):
        LOGGER.debug("Chat id is #%s#", self.chat_id)
        self.bot.send_message(self.chat_id,
                              "[Alarm] {0}".format(text), reply_markup=reply_markup)

    def error_callback(self, _, update, error):
        LOGGER.error("Update \"%s\" caused error \"%s\"", update, error)

    def handle_chat_start(self, _, update):
        LOGGER.debug("starting chat %s", repr(update))
        if self.session is not None:
            self._send_message_async(AUTH_MSG)
            return CONV_AUTH
        return None

    @run_async
    def on_authentication_required(self, _, session):
        self.session = session
        self._authenticate(session)

    @run_async
    def on_authentication_successful(self, *_):
        self._send_message(
            "You have been authenticated. Enter the disarm time (ex: 4h for 4 hours) or just type 0 to disable the alarm.")

    @run_async
    def on_authentication_failed(self, _origin, _session, reason):
        if reason == AuthFailureReason.TIMEOUT:
            self._send_message("Authentication timed-out")

    def on_authentication_ended(self, *_):
        self.session = None

    def _start(self):
        try:
            updater = Updater(bot=self.bot)
            dispatcher = updater.dispatcher
            dispatcher.add_handler(RegexHandler('.*', self.handle_debug), group=1)
            dispatcher.add_handler(RegexHandler('.*', self.handle_save_chat_id), group=2)
            dispatcher.add_handler(CommandHandler("status", self.handle_get_status), group=3)
            dispatcher.add_handler(CommandHandler("photo", self.handle_take_photo), group=3)
            dispatcher.add_handler(CommandHandler("disable", self.handle_disable), group=3)
            dispatcher.add_handler(CommandHandler("enable", self.handle_enable), group=3)
            dispatcher.add_handler(CommandHandler("cam", self.handle_cam), group=3)
            dispatcher.add_handler(CommandHandler("camstatus", self.handle_cam_status), group=3)

            self.conv_handler = ConversationHandler(
                entry_points=[CommandHandler('start', self.handle_chat_start)],
                states={
                    CONV_AUTH: [RegexHandler('.*', self.handle_auth_update)],
                    CONV_SET_DISARM_TIME: [RegexHandler('.*', self.handle_disarm_update)]
                },
                fallbacks=[],  # CommandHandler('cancel', cancel),
                per_user=False
            )
            dispatcher.add_handler(self.conv_handler, group=4)

            dispatcher.add_error_handler(self.error_callback)
            updater.start_polling(timeout=10)
        except Exception:
            LOGGER.exception('Telegram Updater failed to start with error')
        else:
            LOGGER.info("thread running")
