# -*- coding: utf-8 -*-
import time
from enum import Enum
from threading import RLock, Timer
import uuid
import os
import json
from pathlib import Path


from .util import getLogger, human_time
from . import events, parse_duration


LOGGER = getLogger()


def current_milli_time():
    return int(round(time.time() * 1000))


class AlarmState(Enum):
    def __new__(cls, *args):
        obj = object.__new__(cls)
        # pylint: disable=protected-access
        obj._value_ = args[0]
        return obj

    # ignore the first param since it's already set by __new__
    def __init__(self, _, next_states):
        self._next_states_ = next_states

    def __str__(self):
        return self.value

    # this makes sure that the next_states is read-only
    @property
    def next_states(self):
        return self._next_states_

    @staticmethod
    def from_str(a_str):
        for name, member in AlarmState.__members__.items():
            if a_str == name:
                return member
        return None

    ARMED = 'ARMED', ['DISABLED', 'DISARMED', 'AUTHENTICATING']
    DISABLED = 'DISABLED', ['ARMED', 'DISARMED']
    DISARMED = 'DISARMED', ['ARMED', 'DISABLED']
    AUTHENTICATING = 'AUTHENTICATING', ['DISABLED', 'DISARMED', 'ALARMING']
    ALARMING = 'ALARMING', ['DISABLED', 'DISABLED', 'ARMED']


class AuthFailureReason(Enum):
    AUTHENTICATOR_FAILURE = 1
    TIMEOUT = 2
    MAX_AUTH_TRIES = 3


class AuthSession(object):

    def __init__(self, password, max_tries):
        self.id = str(uuid.uuid4())
        self.lock = RLock()
        self.tries = 0
        self.password = password
        self.max_tries = max_tries
        self.remaining_tries = self.tries
        self.disarm_time = 0
        self.is_authenticated = False
        self.last_error = None

    def authenticate(self, origin, pwd):
        with self.lock:
            self.tries += 1
            self.remaining_tries = self.max_tries - self.tries
            if self.tries > self.max_tries:
                events.authentication_failed(origin, self, AuthFailureReason.MAX_AUTH_TRIES)
                return False
            elif pwd == self.password:
                self.is_authenticated = True
                events.authentication_succeeded(origin, self)
                events.authentication_ended(origin, self)
                return True
            else:
                return False

    def __repr__(self):
        return str(self.__dict__)


class Alarm(object):

    def __init__(self, data_file_path, password=None, max_auth_time="30s", default_disarm_time="1h"):
        self.password = password
        self.max_auth_time = parse_duration(max_auth_time).total_seconds()
        self.default_disarm_time = parse_duration(default_disarm_time).total_seconds()
        self.disarm_time = None
        self.state = None
        self.lock = RLock()
        self.sensors = []
        self.authenticators = []
        self.auth_failures_count = 0
        self._register_events_handlers()
        self.current_session = None
        self.data_file_path = Path(data_file_path)
        self.disarm_timeout_thread = None

        if not self.data_file_path.parents[0].exists() or not os.access(str(self.data_file_path.parents[0]), os.W_OK):
            raise Exception("Exception {} can not write".format(str(self.data_file_path)))

    def _register_events_handlers(self):
        events.sensor_started += self.sensors.append
        events.sensor_stopped += lambda x: self.sensors.remove(x) if x in self.sensors else None
        events.authenticator_started += self.authenticators.append
        events.authenticator_stopped += lambda x: self.authenticators.remove(
            x) if x in self.authenticators else None
        events.intrusion_detected += self.on_intrusion_detected
        events.authentication_failed += self.on_authentication_failed
        events.authentication_succeeded += self.on_authentication_successful

    def update_state(self, state, persist=True):
        with self.lock:

            new_state = next((x for x in list(AlarmState) if x.name == str(state)), None)
            if new_state is None:
                raise Exception("Invalid new state {0}".format(state))

            if self.state == new_state:
                LOGGER.debug("state is already %s", new_state)
                return False

            if self.state and not new_state.name in self.state.next_states:
                raise Exception("Forbidden transition from {0} to {1}".format(
                    self.state, new_state))

            # Erase current authentication session
            if self.state == AlarmState.AUTHENTICATING:
                self.current_session = None

            if new_state == AlarmState.AUTHENTICATING:
                self.auth_failures_count = 0
            LOGGER.info("Changing alarm state from %s to %s", self.state, new_state)

            self.state = new_state
            if persist:
                self._persist_alarm_state()

        if self.state == AlarmState.AUTHENTICATING:
            session = AuthSession(self.password, 3)
            self.current_session = session

            def on_auth_timer_expired():
                if self.state == AlarmState.AUTHENTICATING and not session.is_authenticated:
                    self.on_authentication_failed(self, session, AuthFailureReason.TIMEOUT)

            timer = Timer(self.max_auth_time, on_auth_timer_expired)
            timer.start()
            events.alarm_authenticating(self, session)
        else:
            getattr(events, "alarm_"+self.state.name.lower())(self)

        return True

    def on_disarm_time_configuration_expired(self):
        LOGGER.debug("Disarm time configuration expired, disabling the alarm")    
        self.update_state(AlarmState.DISABLED)

    def cancel_disarm_timer(self):
        if self.disarm_timeout_thread is not None:
            try:
                self.disarm_timeout_thread.cancel()
            except Exception:
                LOGGER.exception("Could not cancel disarm timer")

    def set_disarm_time(self, disarm_time):
        LOGGER.debug("Got disarm time of %s", disarm_time)
        if self.state != AlarmState.AUTHENTICATING:
            raise Exception("Cannot set disarm time, state does not allow it")

        if disarm_time == "0" or disarm_time == 0:
            self.cancel_disarm_timer()
            self.update_state(AlarmState.DISABLED)
            return

        with self.lock:
            if isinstance(disarm_time, str):
                LOGGER.debug("setting disarm time of %s", disarm_time)
                self.disarm_time = parse_duration(disarm_time).total_seconds()
                LOGGER.debug("disarm time is now %d", self.disarm_time)
            elif isinstance(disarm_time, (int)):
                self.disarm_time = disarm_time
            else:
                raise Exception("Unsupported disarm time {0}".format(disarm_time))

        self.cancel_disarm_timer()
        self.update_state(AlarmState.DISARMED)

    def get_readable_disarm_time(self):
        if self.disarm_time == 0:
            return "0 seconds"
        else:
            return human_time(seconds=self.disarm_time)

    def on_intrusion_detected(self, *_):
        try:
            if not self.update_state(AlarmState.AUTHENTICATING):
                return
        except Exception as ex:
            LOGGER.error("Could not update state to %s, got exception %s",
                         AlarmState.AUTHENTICATING, ex)
            return

    def on_authentication_successful(self, *_):
        self.disarm_timeout_thread = Timer(60, self.on_disarm_time_configuration_expired)
        self.disarm_timeout_thread.start()

    def on_authentication_failed(self, origin, session, reason):
        self.auth_failures_count += 1
        if reason == AuthFailureReason.MAX_AUTH_TRIES or reason == AuthFailureReason.TIMEOUT:
            LOGGER.debug("authentication failure %s", reason)
            events.authentication_ended(origin, session)
            self.update_state(AlarmState.ALARMING)
        else:
            if len(self.authenticators) == self.auth_failures_count:
                LOGGER.info("No more authenticators ")
                events.authentication_ended(origin, session)
                self.update_state(AlarmState.ALARMING)
            else:
                LOGGER.info("Waiting for other authenticators")

    def start(self):
        if self.data_file_path.exists():
            self._load_alarm_state()
        else:
            self.update_state(state=AlarmState.ARMED)

    def _load_alarm_state(self):
        with open(str(self.data_file_path)) as data_file:
            data = json.load(data_file)
            self.disarm_time = data['disarm_time']
            self.update_state(AlarmState.from_str(data['state']), persist=False)

    def _persist_alarm_state(self):
        data = {
            'state': str(self.state),
            'disarm_time': self.disarm_time
        }
        try:
            with open(str(self.data_file_path), 'w') as data_file:
                json.dump(data, data_file)
        except Exception:
            LOGGER.exception("Could not persist state")
