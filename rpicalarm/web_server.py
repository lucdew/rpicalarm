# -*- coding: utf-8 -*-

from threading import Timer

from flask import Flask, request, Response

from . import network_utils, getLogger, run_async


LOGGER = getLogger(__name__)


class WebServer(object):

    def __init__(self, port=3000, log_dir="/var/log/rpicalarm", auth_username=None, auth_password=None):
        self.port = port
        self.log_dir = log_dir
        self.auth_username = auth_username
        self.auth_password = auth_password
        self.external_ip = None
        self.external_ip_update_running = False
        self.app = Flask(".".join(__name__.split(".")[:-1]))

        self.start_external_ip_updater()

    def check_auth(self, username, password):
        """This function is called to check if a username /
        password combination is valid.
        """
        LOGGER.debug("Configured username=%s,password=%s; received username=%s,password=%s",
                     self.auth_username, self.auth_password, username, password)
        return username == self.auth_username and password == self.auth_password

    def add_route(self, route, route_name, handler, **kwargs):
        self.app.add_url_rule(route, route_name, self.basic_auth_decorate(handler), **kwargs)

    def basic_auth_decorate(self, handler):

        def basic_auth_decorated(*args, **kwargs):
            auth = request.authorization
            if not auth or not self.check_auth(auth.username, auth.password):
                LOGGER.debug("Not authenticated")
                return Response(
                    'Could not verify your access level for that URL.\n'
                    'You have to login with proper credentials', 401,
                    {'WWW-Authenticate': 'Basic realm="Login Required"'})
            return handler(*args, **kwargs)
        return basic_auth_decorated

    def start_external_ip_updater(self):
        if self.external_ip_update_running:
            return
        self.external_ip_update_running = True

        try:
            ext_ip = network_utils.get_external_ip()
            if ext_ip:
                self.external_ip = ext_ip
        except Exception:
            LOGGER.exception("Failed updating external ip")
        finally:
            self.external_ip_update_running = False

        external_ip_update_timer = Timer(120, self.start_external_ip_updater)
        external_ip_update_timer.start()

    @run_async
    def start(self):
        self.app.run(host="0.0.0.0", port=self.port)

    @property
    def auth_base_url(self):
        return "http://{2}:{3}@{0}:{1}".format(self.external_ip, self.port, self.auth_username, self.auth_password)
