# -*- coding: utf-8 -*-

import socket
import os
import logging
import json

from pycmdserver.camera import Camera

server_address = '/tmp/rpicalarm-pybackend.sock'

logger = logging.getLogger()

camera = Camera()

commands = {
    'takePicture': camera.takePictureCmd,
    'takeTimelapse': camera.takeTimelapseCmd,
    'stopTimelapse': camera.stopBackgroundTask
}


class OutStreamWrapper(object):
    def __init__(self, conn):
        self.conn = conn
        self.written = False

    def write(self, data):
        if not self.written:
            self.conn.send(bytes.fromhex("000a"))
            self.written = True
        self.conn.send(data)

    def close(self, status=True):
        data = ""
        if not self.written:
            data = "000a" if status else "010a"
        self.conn.sendall(bytes.fromhex(data))



class Server():
    def __init__(self):
        pass

    def parse_cmd_data(self, data):
        for idx, item in enumerate(data):
            if item == 0x0A:
                try:
                    jsoncmd = json.loads(data[0:idx].decode("utf-8"))
                    if not 'cmd' in jsoncmd:
                        logger.error("command is missing name")
                        return (None, None)
                    cmd = jsoncmd['cmd']
                    if cmd not in commands:
                        logger.error("unknown command %s", cmd)
                        return (None, None)
                    logger.debug("Found command %s", cmd)
                    jsoncmd.pop('cmd')
                    return (commands[cmd], jsoncmd)

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
                cmd, args = self.parse_cmd_data(data)
                logger.debug("cmd=%s,args=%s", cmd, str(args))
                if cmd is not None:
                    cmd(osw, **args)
                else:
                    osw.close(status=False)
                    break

            except Exception as e:
                logger.error("Failed executing or parsing command, got %s",
                             repr(e))

            finally:
                # Clean up the connection
                connection.close()

    def stop(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception as e:
                logger.error("Could not close properly socket, got %s",
                             repr(e))
