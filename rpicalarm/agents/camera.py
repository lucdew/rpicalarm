# -*- coding: utf-8 -*-

import datetime
import time
import io
import os
import subprocess
from threading import Event, Thread

import numpy as np
# pylint: disable=E0401
import picamera
from picamera.array import PiMotionAnalysis


from .. import events, getLogger

TIMELAPSE_WAIT_EVENT = Event()

LOGGER = getLogger(__name__)


def print_proc_stdout(aproc):
    lines_count = 0
    proc_data = b''

    def print_maxed_line():
        nonlocal proc_data, lines_count
        line_max_length = 100
        buf = b'\x00'
        while len(proc_data) <= line_max_length and aproc.poll() is None and int.from_bytes(buf, byteorder='big') != 10:
            buf = aproc.stdout.read(1)
            proc_data += buf

        if proc_data:
            LOGGER.info(str(proc_data, "utf-8"))
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

        except Exception as ex:
            LOGGER.error("got prob %s", repr(ex))

    print_thread = Thread(target=reader)
    print_thread.daemon = True
    print_thread.start()


class MotionDetector(PiMotionAnalysis):
    motion_magnitude = 40
    motion_vectors = 10
    motion_settle_time = 1
    motion_detection_started = 0

    def motion_detected(self, vector_count):
        LOGGER.debug("Motion detected")
        if time.time() - self.motion_detection_started < self.motion_settle_time:
            LOGGER.debug('Ignoring initial motion due to settle time')
            return
        LOGGER.info('Motion detected. Vector count: %s. Threshold: %s',
                    vector_count, self.motion_vectors)

        # TODO: produce events

    def analyze(self, a):
        a = np.sqrt(
            np.square(a['x'].astype(np.float)) +
            np.square(a['y'].astype(np.float))
        ).clip(0, 255).astype(np.uint8)
        vector_count = (a > self.motion_magnitude).sum()
        LOGGER.debug("Vector count %d", vector_count)
        if vector_count > self.motion_vectors:
            self.motion_detected(vector_count)


class Camera(object):
    def __init__(self, photo_size="640x480", motion_size="320x230", stream_size="320x230", video_quality="24", video_bitrate="600000",
                 vflip="True", hflip="False", save_path="/var/tmp/images", youtube_stream_key=None, youtube_url=None):
        self.photo_size = tuple([int(x) for x in photo_size.split('x')])
        self.motion_size = tuple([int(x) for x in motion_size.split('x')])
        self.stream_size = tuple([int(x) for x in stream_size.split('x')])
        self.video_quality = int(video_quality)
        self.video_bitrate = int(video_bitrate)
        self.is_motion_detecting = False
        self.is_streaming = False
        self.is_timelapsing = False
        self.camera = picamera.PiCamera()
        self.camera.vflip = vflip.lower() == "true"
        self.camera.hflip = hflip.lower() == "true"
        self.camera.led = False
        self.camera.resolution = (2592, 1944)
        self.camera.framerate = 15
        self.camera.awb_mode = 'auto'
        self.camera.exposure_mode = 'auto'
        self.image_save_path = save_path
        self.youtube_url = "{}/{}".format(youtube_url, youtube_stream_key)
        self.motion_detector = None
        self.encode_proc = None
        events.alarm_authenticating += self.on_authentication_required
        events.authentication_succeeded += self.on_authentication_succeeded

    def take_photo_io(self):
        osw = io.BytesIO()
        self.camera.capture(osw, format='jpeg', resize=self.photo_size)
        osw.seek(0)
        return osw

    def on_authentication_required(self, _, session):
        self.start_timelapse(file_prefix="camera_{0}".format(session.id))
        return

    def on_authentication_succeeded(self, *_):
        self.stop_timelapse()

    def start_timelapse(self, **kwargs):
        if self.is_timelapsing:
            return
        TIMELAPSE_WAIT_EVENT.clear()
        bg_thread = Thread(name="timelapse", target=self._take_timelapse, kwargs=kwargs)
        bg_thread.daemon = True
        bg_thread.start()
        self.is_timelapsing = True

    def start_motion_detection(self):
        if self.is_motion_detecting:
            return
        if self.motion_detector is None:
            self.motion_detector = MotionDetector(
                self.camera, size=self.motion_size)
        self.camera.start_recording(os.devnull, format='h264', splitter_port=2,
                                    resize=self.motion_detector, motion_output=self.motion_detector)
        LOGGER.debug("motion detection started")
        self.is_motion_detecting = True

    def stop_motion_detection(self):
        if self.motion_detector:
            try:
                self.motion_detector.close()
            except Exception as ex:
                LOGGER.error("Could not close motion_detector %s", repr(ex))
            self.motion_detector = None
        try:
            self.camera.stop_recording(splitter_port=2)
        finally:
            self.is_motion_detecting = False

    def get_state(self):
        states = []
        if self.is_streaming:
            states.append("streaming")
        if self.is_motion_detecting:
            states.append("motion detecting")
        if self.is_timelapsing:
            states.append("timelapsing")
        if not states:
            states.append("not busy")

        return ",".join(states)

    def _take_timelapse(self, timelapse=5, file_prefix="camera"):
        LOGGER.debug("starting timelapse")
        try:
            # Camera warm-up time
            time.sleep(1)

            stream = io.BytesIO()

            for _ in self.camera.capture_continuous(
                    stream, format="jpeg", use_video_port=True, resize=self.photo_size):

                now_string = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S')
                file_name = "{0}_{1}.jpg".format(file_prefix, now_string)
                stream.seek(0)

                tmp_file_path = os.path.join(self.image_save_path, "_{0}".format(file_name))

                with open(tmp_file_path, 'wb') as tmp_file:
                    tmp_file.write(stream.read())

                os.rename(tmp_file_path, os.path.join(self.image_save_path, file_name))

                LOGGER.debug('written picture %s', os.path.join(
                    self.image_save_path, file_name))

                stream.seek(0)
                stream.truncate()

                TIMELAPSE_WAIT_EVENT.wait(timelapse)

                if not self.is_timelapsing:
                    LOGGER.debug("not continuing capture_continuous")
                    break

        except Exception as ex:
            LOGGER.error("Got exception %s", repr(ex))
        finally:
            self.is_timelapsing = False

    def stop_timelapse(self):
        self.is_timelapsing = False
        TIMELAPSE_WAIT_EVENT.set()

    def _stream_to_url(self, url):
        LOGGER.debug("streaming to url %s", url)
        try:
            # Using raspivid raspivid -o - -t 0 -vf -fps 24 -b 600000 | ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv rtmp://a.rtmp.youtube.com/live2/kfem-pm3q-598m-drfp
            # does not work with avconv it seems that it bufferizes too much
            ffmpeg_cmd = "ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv {0}".format(
                url)
            LOGGER.info("Executing %s", ffmpeg_cmd)
            self.encode_proc = subprocess.Popen(
                ffmpeg_cmd.split(" "),
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
            self.is_streaming = True
        except Exception as ex:
            if self.encode_proc and self.encode_proc.poll() is None:
                try:
                    self.encode_proc.kill()
                except Exception as e2:
                    LOGGER.debug("Could not kill video encoding %s", repr(e2))
            raise ex

    def toggle_web_stream(self):
        if self.is_streaming:
            self.stop_web_stream()
            return False
        self._stream_to_url(self.youtube_url)
        return True

    def stop_web_stream(self):
        if self.encode_proc and self.encode_proc.poll() is None:
            try:
                self.encode_proc.kill()
            except Exception as ex:
                LOGGER.debug("Could not kill video encoding %s", repr(ex))
        self.encode_proc = None
        try:
            self.camera.stop_recording()
        finally:
            self.is_streaming = False
