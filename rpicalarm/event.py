# -*- coding: utf-8 -*-
# Enum of events

# Event bus
# emit
# listen

from events import Events


class AlarmSystemEvents(Events):
    __events__ = (
        'sensor_started',
        'sensor_stopped',
        'authenticator_started',
        'authenticator_stopped',  # not used
        'intrusion_detected',
        'authentication_failed',
        'authentication_succeeded',
        'authentication_ended',
        'alarm_authenticating',
        'alarm_alarming',
        'alarm_disarmed',
        'alarm_disabled',
        'alarm_armed',
    )


events = AlarmSystemEvents()
