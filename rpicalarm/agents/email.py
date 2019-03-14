
# -*- coding: utf-8 -*-

import smtplib
import datetime
from urllib.parse import urlparse, unquote

from email.message import EmailMessage
from .. import events, run_async, getLogger


LOGGER = getLogger(__name__)


class Emailer(object):

    def __init__(self, from_email=None, to_email=None, smtp_server_url=None):
        self.from_email = from_email
        self.to_email = to_email
        self._register_events_handlers()
        url_parse_res = urlparse(smtp_server_url)
        self.smtp_host = url_parse_res.hostname
        self.smtp_port = url_parse_res.port
        self.smtp_username = unquote(url_parse_res.username)
        self.smtp_password = unquote(url_parse_res.password)
        self.smtp_is_ssl = url_parse_res.scheme == "smtps"

    def _register_events_handlers(self):
        events.alarm_alarming += self.send_warning_email

    @run_async
    def send_warning_email(self, *_):
        try:
            smtp_func = smtplib.SMTP_SSL if self.smtp_is_ssl else smtplib.SMTP
            smtp_opts = {
                'host': self.smtp_host,
                'timeout': 20
            }
            if self.smtp_port:
                smtp_opts['port'] = self.smtp_port

            with smtp_func(**smtp_opts) as smtp:
                msg = EmailMessage()
                msg['Subject'] = '[rpicalarm] Intrusion detected'
                msg['From'] = self.from_email
                msg['To'] = self.to_email
                msg_text = "Intrusion detected at {}".format(
                    datetime.datetime.now().strftime('%H:%M:%S %d/%m/%Y'))
                msg.set_content(msg_text)
                msg.add_alternative("""\
                <html>
                <head></head>
                <body>
                   <p> <b>{}</b></p>
                </body>
                </html>
                """.format(msg_text), subtype='html')

                if self.smtp_username:
                    LOGGER.debug("login in with username=%s,password=%s",
                                 self.smtp_username, self.smtp_password)
                    smtp.login(self.smtp_username, self.smtp_password)
                smtp.send_message(msg)
                LOGGER.debug("message sent")

        except Exception:
            LOGGER.exception("Failed sending warning email")
