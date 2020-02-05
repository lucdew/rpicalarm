# -*- coding: utf-8 -*-

import logging
import math
import types
import sys
import re
from datetime import timedelta
from functools import wraps
from threading import Thread

duration_regex = re.compile(r'((?P<hours>\d+?)h)?((?P<minutes>\d+?)m)?((?P<seconds>\d+?)s)?')


def run_async(func):
    """
    Function decorator that will run the function in a new daemonized thread.
    """

    @wraps(func)
    def async_func(*args, **kwargs):
        func_hl = Thread(target=func, daemon=True, args=args, kwargs=kwargs)
        func_hl.start()
        return func_hl

    return async_func

def human_time(*args, **kwargs):
    secs  = float(timedelta(*args, **kwargs).total_seconds())
    units = [("day", 86400), ("hour", 3600), ("minute", 60), ("second", 1)]
    parts = []
    for unit, mul in units:
        if secs / mul >= 1 or mul == 1:
            if mul > 1:
                n = int(math.floor(secs / mul))
                secs -= n * mul
            else:
                n = secs if secs != int(secs) else int(secs)
            parts.append("%s %s%s" % (n, unit, "" if n == 1 else "s"))
    return ", ".join(parts)

def parse_duration(time_str):
    parts = duration_regex.match(time_str)
    if not parts:
        raise Exception("Invalid duration string {0}".format(time_str))
    parts = parts.groupdict()
    time_params = {}
    for (name, param) in parts.items():
        if param:
            time_params[name] = int(param)
    return timedelta(**time_params)


def time_seconds_to_duration_str(a_time):
    return str(timedelta(seconds=a_time))


def getLogger(name=None):
    logger = logging.getLogger(name)

    def fatal(target, msg, *args, **kwargs):
        target.error(msg, *args, **kwargs)
        logging.shutdown()
        sys.exit(-1)

    logger.fatal = types.MethodType(fatal, logger)

    return logger
