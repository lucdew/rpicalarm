# -*- coding: utf-8 -*-

import socket
import toml
import grpc
import os
import logging
import json
from datetime import datetime

from backendserver.camera import Camera
from backendserver import backend_pb2
from backendserver import backend_pb2_grpc
from concurrent import futures


logger = logging.getLogger()


class CameraService(backend_pb2_grpc.CameraServiceServicer):

    def __init__(self, cfg):
        params = {a_key: cfg['agents']['camera'][a_key] for a_key in [
            'vflip', 'hflip', 'photo_size', 'stream_size', 'motion_size', 'video_quality', 'video_bitrate', 'save_path']}
        params['motion_detection_listener'] = self._on_motion_detected
        self.camera = Camera(**params)
        self.motions_detections = []

    def ToggleWebStream(self, request, context):
        res = self._invoke("toggle_web_stream", url=request.url)
        return backend_pb2.ToggleWebStreamReply(result=res["result"], isStreaming=res["data"])

    def TakePicture(self, request, context):
        res = self._invoke("take_picture")
        return backend_pb2.TakePictureReply(result=res["result"], picture=res["data"])

    def StartTimelapse(self, request, context):
        res = self._invoke("start_timelapse")
        return backend_pb2.BasicReply(result=res["result"])

    def StopTimelapse(self, request, context):
        res = self._invoke("stop_timelapse")
        return backend_pb2.BasicReply(result=res["result"])

    def StartMotionDetection(self, request, context):
        res = self._invoke("start_motion_detection")
        return backend_pb2.BasicReply(result=res["result"])

    def StopMotionDetection(self, request, context):
        res = self._invoke("stop_motion_detection")
        return backend_pb2.BasicReply(result=res["result"])

    def GetState(self, request, context):
        res = self._invoke("get_state")
        return backend_pb2.GetStateReply(result=res["result"], state=res["data"])

    def SubscribeNotifications(self, request_iterator, context):
        # For every client a infinite loop starts (in gRPC's own managed thread)
        while True:
            # Check if there are any new messages
            while len(self.motions_detections) > 0:
                yield self.motions_detections.pop()

    def _on_motion_detected(self):
        self.motions_detections.append(backend_pb2.Notification(
            name="motion_detected", timestamp=datetime.now().microsecond))

    def _invoke(self, camera_func, **args):
        ares = None
        status = True
        msg = None
        try:
            ares = getattr(self.camera, camera_func)(**args)
        except Exception as e:
            logger.error("Got exception %s", repr(e))
            status = False
            msg = "%s" % repr(e)

        return {
            "result": backend_pb2.CameraResult(status=status, message=msg),
            "data": ares
        }


class Server():
    def __init__(self, cfg):
        self.cfg = cfg
        self.cameraService = CameraService(cfg)

    def start(self):
        self.server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
        backend_pb2_grpc.add_CameraServiceServicer_to_server(self.cameraService, self.server)
        self.server.add_insecure_port('localhost:50051')
        self.server.start()
        logger.info("server started on localhost:50051")

    def stop(self):
        self.server.stop(0)
        logger.info("server stopped")
