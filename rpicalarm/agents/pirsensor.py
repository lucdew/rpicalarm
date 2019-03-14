# -*- coding: utf-8 -*-
from time import time

# disable pylint for module for development on non-arm machine
# pylint: disable=E0401
import RPi.GPIO as GPIO

from .. import events, getLogger


LOGGER = getLogger(__name__)


class PirSensor(object):

    def __init__(self, pin_num):
        self.pin_num = int(pin_num)
        LOGGER.debug("GPIO numbering mode is %s (GPIO.BOARD=%s,GPIO.BCM=%s)",
                     GPIO.getmode(), GPIO.BOARD, GPIO.BCM)
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(self.pin_num, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
        self._register_events_handlers()
        self.last_event = None

    def _register_events_handlers(self):
        events.alarm_disabled += self._stop
        events.alarm_disarmed += self._stop
        events.alarm_armed += self._start

    def on_pin_event(self, _channel):
        LOGGER.debug("pin event")
        last_event = self.last_event
        current_event = time()
        self.last_event = current_event
        if last_event is not None and current_event - last_event < 15:
            LOGGER.debug("detected motion")
            events.intrusion_detected(self)

    def _start(self, *_):
        GPIO.add_event_detect(self.pin_num, GPIO.RISING, callback=self.on_pin_event, bouncetime=200)
        events.sensor_started(self)
        LOGGER.debug("Started monitoring events on pin %s", self.pin_num)

    def _stop(self, *_):
        GPIO.remove_event_detect(self.pin_num)
        events.sensor_stopped(self)
        LOGGER.debug("Stopped monitoring events on pin %s", self.pin_num)

    def __str__(self):
        return "pirsensor (pin_num={0})".format(self.pin_num)
