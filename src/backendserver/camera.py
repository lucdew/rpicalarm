# -*- coding: utf-8 -*-

# pylint: disable=E0401
import picamera
from picamera.array import PiMotionAnalysis
import datetime
import time
import io
import os
import logging
import time
import numpy as np
import subprocess
from threading import Event, Thread
from enum import Enum

timelapse_wait_event = Event()

logger = logging.getLogger()


def print_proc_stdout(aproc):
    lines_count = 0
    proc_data = b''

    def print_maxed_line():
        nonlocal proc_data, lines_count
        line_max_length = 100
        b = b'\x00'
        while len(proc_data) <= line_max_length and aproc.poll() is None and int.from_bytes(b, byteorder='big') != 10:
            b = aproc.stdout.read(1)
            proc_data += b

        if len(proc_data) > 0:
            logger.info(str(proc_data, "utf-8"))
            lines_count += 1
            proc_data = b''

    def reader():
        nonlocal lines_count
        try:
            while aproc.poll() is None and lines_count < 30:
                print_maxed_line()

            while aproc.poll() is None:
                time.sleep(5)
                print_maxed_line()

        except Exception as e:
            logger.error("got prob %s", repr(e))
            pass

    t = Thread(target=reader)
    t.daemon = True
    t.start()


class MotionDetector(PiMotionAnalysis):
    motion_magnitude = 40
    motion_vectors = 10
    motion_settle_time = 1
    motion_detection_started = 0

    def __init__(self, camera, size=None, motion_detection_listener=None):
        super(MotionDetector, self).__init__(camera, size)
        self.motion_detection_listener = motion_detection_listener

    def motion_detected(self, vector_count):
        logger.debug("Motion detected")
        if time.time() - self.motion_detection_started < self.motion_settle_time:
            logger.debug('Ignoring initial motion due to settle time')
            return
        logger.info('Motion detected. Vector count: {0}. Threshold: {1}'.format(
            vector_count, self.motion_vectors))
        if self.motion_detection_listener:
            self.motion_detection_listener()

    def analyze(self, a):
        a = np.sqrt(
            np.square(a['x'].astype(np.float)) +
            np.square(a['y'].astype(np.float))
        ).clip(0, 255).astype(np.uint8)
        vector_count = (a > self.motion_magnitude).sum()
        logger.debug("Vector count %d", vector_count)
        if vector_count > self.motion_vectors:
            self.motion_detected(vector_count)


class Camera(object):
    def __init__(self, photo_size="640x480", motion_size="320x230", stream_size="320x230", video_quality=24, video_bitrate=600000, vflip=True, hflip=False,
                 save_path="/var/tmp/images", motion_detection_listener=None):
        self.photo_size = tuple([int(x) for x in photo_size.split('x')])
        self.motion_size = tuple([int(x) for x in motion_size.split('x')])
        self.stream_size = tuple([int(x) for x in stream_size.split('x')])
        self.video_quality = video_quality
        self.video_bitrate = video_bitrate
        self.isMotionDetecting = False
        self.isStreaming = False
        self.isTimelapsing = False
        self.camera = picamera.PiCamera()
        self.camera.vflip = vflip
        self.camera.hflip = hflip
        self.camera.led = False
        self.camera.resolution = (2592, 1944)
        self.camera.framerate = 15
        self.camera.awb_mode = 'auto'
        self.camera.exposure_mode = 'auto'
        self.image_save_path = save_path
        self.motion_detector = None
        self.encode_proc = None
        self.motion_detection_listener = motion_detection_listener

    def take_picture(self):
        with io.BytesIO() as osw:
            self.camera.capture(osw, format='jpeg', resize=self.photo_size)
            return osw.getvalue()

    def start_timelapse(self, **kwargs):
        if self.isTimelapsing:
            return
        timelapse_wait_event.clear()
        bg_thread = Thread(name="timelapse", target=self._take_timelapse, kwargs=kwargs)
        bg_thread.daemon = True
        bg_thread.start()
        self.isTimelapsing = True

    def start_motion_detection(self):
        if self.isMotionDetecting:
            return
        if self.motion_detector is None:
            self.motion_detector = MotionDetector(
                self.camera, size=self.motion_size, motion_detection_listener=self.motion_detection_listener)
        self.camera.start_recording(os.devnull, format='h264', splitter_port=2,
                                    resize=self.motion_detector, motion_output=self.motion_detector)
        logger.debug("motion detection started")
        self.isMotionDetecting = True

    def stop_motion_detection(self):
        if self.motion_detector:
            try:
                self.motion_detector.close()
            except Exception as e:
                logger.error("Could not close motion_detector %s", repr(e))
            self.motion_detector = None
        try:
            self.camera.stop_recording(splitter_port=2)
        finally:
            self.isMotionDetecting = False

    def get_state(self):
        states = []
        if self.isStreaming:
            states.append("streaming")
        if self.isMotionDetecting:
            states.append("motion detecting")
        if self.isTimelapsing:
            states.append("timelapsing")
        if len(states) == 0:
            states.append("not busy")

        return ",".join(states)

    def _take_timelapse(self, timelapse=10):
        global timelapse_wait_event
        logger.debug("starting timelapse")
        try:
            # Camera warm-up time
            time.sleep(1)

            stream = io.BytesIO()

            for _ in self.camera.capture_continuous(
                    stream, format="jpeg", use_video_port=True, resize=self.photo_size):

                file_name = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S.jpg')
                stream.seek(0)

                tmp_file = os.path.join(self.image_save_path, "_{0}".format(file_name))

                with open(tmp_file, 'wb') as f:
                    f.write(stream.read())

                os.rename(tmp_file, os.path.join(self.image_save_path, file_name))

                logger.debug('written picture %s', os.path.join(
                    self.image_save_path, file_name))

                stream.seek(0)
                stream.truncate()

                timelapse_wait_event.wait(timelapse)

                if not self.isTimelapsing:
                    logger.debug("not continuing capture_continuous")
                    break

        except Exception as e:
            logger.error("Got exception %s", repr(e))
        finally:
            self.isTimelapsing = False

    def stop_timelapse(self):
        global timelapse_wait_event
        timelapse_wait_event.set()
        self.isTimelapsing = False

    def stream_to_url(self, url):
        logger.debug("streaming to url %s", url)
        try:
            # Using raspivid raspivid -o - -t 0 -vf -fps 24 -b 600000 | ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv rtmp://a.rtmp.youtube.com/live2/kfem-pm3q-598m-drfp
            # does not work with avconv it seems that it bufferizes too much
            self.encode_proc = subprocess.Popen(
                "ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv {0}".format(
                    url).split(" "),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.camera.start_recording(
                self.encode_proc.stdin,
                format='h264',
                # The H.264 profile to use for encoding. Defaults to ‘high’, but can be one of ‘baseline’, ‘main’, ‘extended’, ‘high’, or ‘constrained’.
                profile="main",
                resize=self.stream_size,
                quality=self.video_quality,
                bitrate=self.video_bitrate)
            print_proc_stdout(self.encode_proc)
            self.isStreaming = True
        except Exception as e:
            if self.encode_proc and self.encode_proc.poll() is None:
                try:
                    self.encode_proc.kill()
                except Exception as e2:
                    logger.debug("Could not kill video encoding %s", repr(e2))
            raise e

    def toggle_web_stream(self, url):
        if self.isStreaming:
            self.stop_web_stream()
            return False
        self.stream_to_url(url)
        return True

    def stop_web_stream(self):
        if self.encode_proc and self.encode_proc.poll() is None:
            try:
                self.encode_proc.kill()
            except Exception as e:
                logger.debug("Could not kill video encoding %s", repr(e))
        self.encode_proc = None
        try:
            self.camera.stop_recording()
        finally:
            self.isStreaming = False
