# -*- coding: utf-8 -*-

import socket
import os
import logging
import json

from pycmdserver.camera import Camera

server_address = '/tmp/rpicalarm-pybackend.sock'

logger = logging.getLogger()


class OutStreamWrapper(object):
    def __init__(self, conn):
        self.conn = conn
        self.written = False
        self.closed = False

    def write(self, data):
        if not self.written:
            self.conn.send(bytes.fromhex("000a"))
            self.written = True
        self.conn.send(data)

    def close(self, error_msg=None):
        if self.closed:
            return
        if not self.written:
            data = "000a" if not error_msg else "010a"
            self.conn.send(bytes.fromhex(data))
        if error_msg:
            self.conn.send(error_msg.encode("utf-8"))
        self.closed = True
        self.conn.close()


class Server():
    def __init__(self, cfg):
        self.cfg = cfg
        self.camera = Camera(cfg['agents']['camera'])

    def parse_cmd_data(self, data):
        for idx, item in enumerate(data):
            if item == 0x0A:
                try:
                    jsoncmd = json.loads(data[0:idx].decode("utf-8"))
                    if not 'target' in jsoncmd:
                        logger.error("command or target are missing")
                        return (None, None)
                    target = jsoncmd.pop('target')
                    logger.debug("Found target %s", target)
                    if target == 'camera':
                        target = self.camera
                    else:
                        logger.error("Unsupported target %s", target)
                        return (None, jsoncmd)

                    return (target, jsoncmd)

                except Exception as e:
                    logger.error("Got invalid data, error %s", repr(e))

        return (None, None)

    def start(self):
        # Make sure the socket does not already exist
        try:
            os.unlink(server_address)
        except OSError:
            if os.path.exists(server_address):
                raise

        # Create a UDS socket
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(server_address)

        # Listen for incoming connections
        self.sock.listen(1)

        logger.info("pycmdserver started")

        while True:
            # Wait for a connection
            logger.debug('waiting for a connection')
            connection, client_address = self.sock.accept()
            osw = OutStreamWrapper(connection)
            logger.debug('connection accepted from %s', str(client_address))

            data = connection.recv(4096)
            try:
                target, args = self.parse_cmd_data(data)
                if target is not None:
                    target.invoke(osw, **args)
                else:
                    osw.close("Unsupported or missing target")
                    break

            except Exception as e:
                logger.error("Failed executing or parsing command, got %s",
                             repr(e))

            finally:
                # Clean up the connection
                osw.close()

    def stop(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception as e:
                logger.error("Could not close properly socket, got %s",
                             repr(e))
