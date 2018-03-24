#!/usr/bin/env python3

import argparse
import logging
import sys
import os
import socket
from configparser import SafeConfigParser
import toml
from pycmdserver.server import Server

#import logging.handlers


def parse_arguments():
    p = argparse.ArgumentParser(
        description='Alarm system running on RaspberryPi.')
    p.add_argument('-c', '--config', help='Path to config file.',
                   default='etc/rpicalarm.conf')
    p.add_argument('-v', '--verbose',
                   help='Enable verbose mode', default=False)
    return p.parse_args()


def setup_logging(debug_mode):
    logger = logging.getLogger()
    if debug_mode:
        logger.setLevel(logging.DEBUG)
    stdout_format = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(filename)s:%(lineno)-12s %(threadName)-25s %(message)s", "%Y-%m-%d %H:%M:%S")
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(stdout_format)
    # stdout_handler.setLevel(stdout_level)
    logger.addHandler(stdout_handler)
    return logger


if __name__ == "__main__":
    args = parse_arguments()
    logger = setup_logging(debug_mode=args.verbose)

    try:
        with open(args.config) as f:
            cfg = toml.load(f)
    except Exception as e:
        logger.fatal(
            "Failed reading configuration, got exception {0}".format(e))

    if 'logging' in cfg:
        logging_cfg = cfg['logging']
        log_level = logging_cfg['level'] if 'level' in logging_cfg else None
    if not args.verbose:
        logger.setLevel(getattr(logging, log_level.upper()))

    s = Server()
    s.start()
