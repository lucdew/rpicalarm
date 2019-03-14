#!/usr/bin/env python3

import argparse
import logging

#import logging.handlers
from configparser import SafeConfigParser
from rpicalarm import Alarm, getLogger, WebServer
from rpicalarm.agents import Telegram, Camera, PirSensor, Backuper, Twilio, Emailer


def parse_arguments():
    arg_parser = argparse.ArgumentParser(description='Alarm system running on RaspberryPi.')
    arg_parser.add_argument('-c', '--config', help='Path to config file.',
                            default='/etc/rpicalarm.conf')
    arg_parser.add_argument('-s', '--data_file', help='Path the data file.',
                            default='/var/lib/rpicalarm/data.json')
    arg_parser.add_argument('-v', '--verbose', help='Enable verbose mode', default=False)
    return arg_parser.parse_args()


def setup_logging(debug_mode):
    root_logger = getLogger()
    if debug_mode:
        root_logger.setLevel(logging.DEBUG)
    # syslog_handler = logging.handlers.SysLogHandler(address='/dev/log')
    # syslog_format = logging.Formatter(
    #     "%(filename)s:%(threadName)s %(message)s", "%Y-%m-%d %H:%M:%S")
    # syslog_handler.setFormatter(syslog_format)
    # if log_to_stdout:
    #stdout_level = logging.DEBUG
    stdout_format = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(filename)s:%(lineno)-12s %(threadName)-25s %(message)s", "%Y-%m-%d %H:%M:%S")
    # else:
    #     stdout_level = logging.CRITICAL
    #     stdout_format = logging.Formatter("ERROR: %(message)s")
    # if debug_mode:
    #     syslog_handler.setLevel(logging.DEBUG)
    # else:
    #     syslog_handler.setLevel(logging.INFO)
    # logger.addHandler(syslog_handler)
    stdout_handler = logging.StreamHandler()
    stdout_handler.setFormatter(stdout_format)
    # stdout_handler.setLevel(stdout_level)
    root_logger.addHandler(stdout_handler)
    return root_logger


#pylint: disable=invalid-name
if __name__ == "__main__":
    args = parse_arguments()
    logger = setup_logging(debug_mode=args.verbose)

    try:
        with open(args.config) as f:
            cfg = SafeConfigParser(interpolation=None)
            cfg.read_file(f)
    except Exception as e:
        logger.fatal("Failed reading configuration, got exception {0}".format(e))

    log_level = cfg.get('logging', 'level', fallback='info')
    if not args.verbose:
        logger.setLevel(getattr(logging, log_level.upper()))

    camera = Camera(**cfg['camera'])
    alarm = Alarm(args.data_file, **cfg['alarm'])
    telegram = Telegram(alarm, camera, **cfg['telegram'])
    pir_sensor = PirSensor(**cfg['pirsensor'])
    backuper = Backuper(cfg['camera'].get("save_path"), cloudinary_cfg=cfg['cloudinary'])
    web_server = WebServer(**cfg['webServer'])
    twilio = Twilio(alarm, web_server, **cfg['twilio'])
    emailer = Emailer(**cfg['email'])

    web_server.start()
    alarm.start()
