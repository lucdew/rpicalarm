# -*- coding: utf-8 -*-

import datetime
from enum import Enum
import time
import io
import os
import subprocess
from threading import Event, Thread, RLock

import numpy as np
import cv2
import imutils


# pylint: disable=E0401
import picamera
from picamera.array import PiMotionAnalysis
from .. import events, getLogger

TIMELAPSE_WAIT_EVENT = Event()

LOGGER = getLogger(__name__)


class CameraError(Exception):
    pass


class CameraAlreadyInStateError(CameraError):
    pass


class CameraBusyError(CameraError):
    pass


class CameraFlags(Enum):
    TAKING_PICTURE = 1
    STREAMING = 2
    MOTION_DETECTING = 4
    TIMELAPSING = 8


class CameraPort(Enum):
    STILL = 1
    VIDEO = 2


def bit_count(int_type):
    count = 0
    while int_type:
        int_type &= int_type - 1
        count += 1
    return count


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


class Camera(object):
    def __init__(self, vflip="True", hflip="False", save_path="/var/tmp/images",
                 motion_size="320x230", stream_size="320x230", video_quality="24",
                 video_bitrate="600000", youtube_stream_key=None, youtube_url=None):
        self.motion_size = tuple([int(x) for x in motion_size.split('x')])
        self.stream_size = tuple([int(x) for x in stream_size.split('x')])
        self.video_quality = int(video_quality)
        self.video_bitrate = int(video_bitrate)
        self.camera = picamera.PiCamera()
        self.camera.vflip = vflip.lower() == "true"
        self.camera.hflip = hflip.lower() == "true"
        self.camera.led = False
        self.camera.resolution = (1920, 1080)
        self.camera.framerate = 30
        self.camera.awb_mode = 'auto'
        self.camera.exposure_mode = 'auto'
        self.image_save_path = save_path
        self.youtube_url = "{}/{}".format(youtube_url, youtube_stream_key)
        self.motion_detector = None
        self.encode_proc = None
        events.alarm_authenticating += self.on_authentication_required
        events.authentication_succeeded += self._stop_timelapse_from_event
        events.alarm_disarmed += self._stop_timelapse_from_event
        events.alarm_disabled += self._stop_timelapse_from_event
        self.flags = 0
        self.still_port_in_use = 0
        self.lock = RLock()

    def _acquire_flag(self, a_flag, port=None):

        with self.lock:
            if self._is_flag_set(a_flag):
                raise CameraAlreadyInStateError("Flag {} is already set".format(a_flag.name))

            # Limit operations to 2
            if bit_count(self.flags) >= 2:
                raise CameraBusyError("Cannot set flag {}, camera has already {} flags set".format(
                    a_flag.name, self.get_state()))

            self.flags |= a_flag.value

            if port is None:
                if self.still_port_in_use == 0:
                    self.still_port_in_use = a_flag.value
                    return CameraPort.STILL
                else:
                    return CameraPort.VIDEO
            elif port == CameraPort.STILL:
                if self.still_port_in_use != 0:
                    raise CameraBusyError("Still port is in use cannot continue")
                self.still_port_in_use = a_flag.value
                return CameraPort.STILL
            else:
                return CameraPort.VIDEO

    def _unset_flag(self, a_flag):
        with self.lock:
            if self.still_port_in_use & a_flag.value == a_flag.value:
                self.still_port_in_use = 0
                LOGGER.debug("self.still_port_in_use=%d", self.still_port_in_use)
            self.flags ^= a_flag.value
            LOGGER.debug("Unset flag %s self.flags=%d", a_flag.name, self.flags)

    def _is_flag_set(self, a_flag):
        is_flag_set = (a_flag.value & self.flags) == a_flag.value
        LOGGER.debug("Flag %s is_set=%s, flags=%d", a_flag.name, is_flag_set, self.flags)
        return is_flag_set

    def take_photo_io(self):
        port = self._acquire_flag(CameraFlags.TAKING_PICTURE)
        try:
            osw = io.BytesIO()
            self.camera.capture(osw, format='jpeg', use_video_port=port == CameraPort.VIDEO)
            osw.seek(0)
            return osw
        finally:
            self._unset_flag(CameraFlags.TAKING_PICTURE)

    def on_authentication_required(self, _, session):
        try:
            port = self._acquire_flag(CameraFlags.TIMELAPSING)
            self.start_timelapse(file_prefix="camera_{0}".format(session.id), port=port)
        except CameraAlreadyInStateError:
            return

    def _stop_timelapse_from_event(self, *_):
        self.stop_timelapse()

    def start_timelapse(self, **kwargs):
        TIMELAPSE_WAIT_EVENT.clear()
        bg_thread = Thread(
            name="timelapse", target=self._take_timelapse, kwargs=kwargs)
        bg_thread.daemon = True
        bg_thread.start()

    def start_motion_detection(self):

        try:
            self._acquire_flag(CameraFlags.MOTION_DETECTING, port=CameraPort.STILL)
        except CameraAlreadyInStateError:
            return

        min_area = 500
        past_frame = None
        LOGGER.debug("Starting motion detection")
        while self._is_flag_set(CameraFlags.MOTION_DETECTING):
            stream = io.BytesIO()
            self.camera.capture(stream, format='jpeg', use_video_port=False,
                                resize=self.motion_size)
            data = np.fromstring(stream.getvalue(), dtype=np.uint8)
            frame = cv2.imdecode(data, 1)

            # if frame is initialized, we have not reach the end of the video
            if frame is not None:
                past_frame = self.handle_new_frame(frame, past_frame, min_area)
            else:
                LOGGER.error("No more frame")
            # rpis.state.check()
            time.sleep(0.3)
            # self.stop_motion_detection()
        LOGGER.debug("motion detection started")

    # def stop_motion_detection(self):
    #     if self.motion_detector:
    #         try:
    #             self.motion_detector.close()
    #         except Exception as ex:
    #             LOGGER.error("Could not close motion_detector %s", repr(ex))
    #         self.motion_detector = None
    #     try:
    #         self.camera.stop_recording(splitter_port=2)
    #     finally:
    #         self.is_motion_detecting = False

    def handle_new_frame(self, frame, past_frame, min_area):
        #cv2.imwrite("raw_frame_%d.jpg" % i, frame)
        (height, width) = frame.shape[:2]
        ratio = 500 / float(width)
        dim = (500, int(height * ratio))

        frame = cv2.resize(frame, dim, cv2.INTER_AREA)  # We resize the frame
        # We apply a black & white filter
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)  # Then we blur the picture

        #cv2.imwrite("gray_frame_%d.jpg" % i, gray)

        # if the first frame is None, initialize it because there is no frame for comparing the current one with a previous one
        if past_frame is None:
            past_frame = gray
            return past_frame

        # check if past_frame and current have the same sizes
        (h_past_frame, w_past_frame) = past_frame.shape[:2]
        (h_current_frame, w_current_frame) = gray.shape[:2]
        # This shouldnt occur but this is error handling
        if h_past_frame != h_current_frame or w_past_frame != w_current_frame:
            LOGGER.error('Past frame and current frame do not have the same sizes {0} {1} {2} {3}'.format(
                h_past_frame, w_past_frame, h_current_frame, w_current_frame))
            return

        # compute the absolute difference between the current frame and first frame
        frame_detla = cv2.absdiff(past_frame, gray)
        # then apply a threshold to remove camera motion and other false positives (like light changes)
        thresh = cv2.threshold(frame_detla, 50, 255, cv2.THRESH_BINARY)[1]

        # dilate the thresholded image to fill in holes, then find contours on thresholded image
        thresh = cv2.dilate(thresh, None, iterations=2)
        #cv2.imwrite("thresh_frame_%d.jpg" % i, thresh)
        cnts = cv2.findContours(
            thresh.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnts = cnts[0] if imutils.is_cv2() else cnts[1]

        # loop over the contours
        for c in cnts:
            # print(cv2.contourArea(c))
            # if the contour is too small, ignore it
            if cv2.contourArea(c) < min_area:
                continue

            LOGGER.debug("Motion detected!")
            # Motion detected because there is a contour that is larger than the specified min_area
            # compute the bounding box for the contour, draw it on the frame,
            (x, y, w, h) = cv2.boundingRect(c)
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
            # TODO pass frame
            events.intrusion_detected(self)
            #cv2.imwrite("motion_%d.jpg" % i, frame)

    def get_state(self):
        states = []
        for flag in CameraFlags:
            if self._is_flag_set(flag):
                states.append(flag.name.lower())

        return ",".join(states)

    def _take_timelapse(self, timelapse=5, file_prefix="camera", port=CameraPort.VIDEO):
        LOGGER.debug("starting timelapse")
        try:
            # Camera warm-up time
            time.sleep(1)

            stream = io.BytesIO()

            for _ in self.camera.capture_continuous(
                    stream, format="jpeg", use_video_port=port == CameraPort.VIDEO):

                now_string = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S')
                file_name = "{0}_{1}.jpg".format(file_prefix, now_string)
                stream.seek(0)

                tmp_file_path = os.path.join(
                    self.image_save_path, "_{0}".format(file_name))

                with open(tmp_file_path, 'wb') as tmp_file:
                    tmp_file.write(stream.read())

                os.rename(tmp_file_path, os.path.join(
                    self.image_save_path, file_name))

                LOGGER.debug('written picture %s', os.path.join(
                    self.image_save_path, file_name))

                stream.seek(0)
                stream.truncate()

                TIMELAPSE_WAIT_EVENT.wait(timelapse)

                if not self._is_flag_set(CameraFlags.TIMELAPSING):
                    LOGGER.debug("not continuing capture_continuous")
                    break

        except Exception as ex:
            LOGGER.error("Got exception %s", repr(ex))

    def stop_timelapse(self):
        LOGGER.debug("Stopping timelapse")
        if not self._is_flag_set(CameraFlags.TIMELAPSING):
            return
        self._unset_flag(CameraFlags.TIMELAPSING)
        TIMELAPSE_WAIT_EVENT.set()
        LOGGER.debug("Stopped timelapse")

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
        except Exception as ex:
            if self.encode_proc and self.encode_proc.poll() is None:
                try:
                    self.encode_proc.kill()
                except Exception:
                    LOGGER.exception("Could not kill video encoding")
            raise ex

    def toggle_web_stream(self):
        if self._is_flag_set(CameraFlags.STREAMING):
            self._stop_web_stream()
            return False
        else:
            self._acquire_flag(CameraFlags.STREAMING, port=CameraPort.VIDEO)
            self._stream_to_url(self.youtube_url)
            return True

    def _stop_web_stream(self):
        try:
            self.camera.stop_recording()
            if self.encode_proc and self.encode_proc.poll() is None:
                try:
                    self.encode_proc.kill()
                except Exception as ex:
                    LOGGER.debug("Could not kill video encoding %s", repr(ex))
            self.encode_proc = None
        finally:
            self._unset_flag(CameraFlags.STREAMING)
