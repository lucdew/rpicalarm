# -*- coding: utf-8 -*-
import json

import urllib3


def get_external_ip():
    http = urllib3.PoolManager()
    res = http.request('GET', 'http://ipinfo.io', timeout=20.0)

    if res.status == 200 and res.data:
        return json.loads(res.data.decode("utf-8"))["ip"]

    return None
