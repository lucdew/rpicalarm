# -*- coding: utf-8 -*-

# pylint: disable=E0401
import picamera
import datetime
import time
import io
import os
import logging
import time
import subprocess
from threading import Lock, Event, Thread
from enum import Enum

logger = logging.getLogger()


lock = Lock()
wait_event = Event()
continue_thread = False


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


class CameraState(Enum):

    WAITING = "waiting for instructions"
    TIMELAPSING = "taking photos continuously"
    STREAMING = "streaming webcam"

    def __repr__(self):
        return '<%s.%s>' % (self.__class__.__name__, self.name)


class Camera(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.cfg['image_size'] = tuple([int(x) for x in self.cfg['image_size'].split('x')])
        self.cfg['motion_size'] = tuple([int(x) for x in self.cfg['motion_size'].split('x')])
        self.camera = None
        self.state = CameraState.WAITING
        self.priority = 0

    def init_camera(self):
        if self.camera:
            return
        self.camera = picamera.PiCamera()
        self.camera.vflip = self.cfg['vflip']
        self.camera.hflip = self.cfg['hflip']
        self.camera.led = False

    def _set_normal_settings(self):
        self.camera.awb_mode = 'auto'
        self.camera.exposure_mode = 'auto'
        self.resolution = self.cfg['image_size']
        self.framerate = self.cfg['video_framerate']

    def _set_motion_settings(self):
        self.camera.resolution = self.cfg['motion_size']
        self.camera.framerate = self.cfg['motion_framerate']
        exposure_speed = self.camera.exposure_speed
        self.camera.shutter_speed = exposure_speed
        self.camera.awb_mode = 'off'
        self.camera.exposure_mode = 'off'

    def take_picture(self, osw):
        self._set_normal_settings()
        #camera.capture(osw, 'jpeg', resize=(width, height))
        self.camera.capture(osw, 'jpeg')

    def _take_timelapse(self, timelapse=10):
        global continue_thread, wait_event, lock
        with lock:
            self.state = CameraState.TIMELAPSING
            logger.debug("starting timelapse")
            try:
                self._set_normal_settings()
                # Camera warm-up time
                time.sleep(1)

                stream = io.BytesIO()

                for _ in self.camera.capture_continuous(
                        stream, 'jpeg'):

                    file_name = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S.jpg')
                    stream.seek(0)

                    tmp_file = os.path.join(self.cfg['save_path'], "_{0}".format(file_name))

                    with open(tmp_file, 'wb') as f:
                        f.write(stream.read())

                    os.rename(tmp_file, os.path.join(self.cfg['save_path'], file_name))

                    logger.debug('written picture %s', os.path.join(
                        self.cfg['save_path'], file_name))

                    stream.seek(0)
                    stream.truncate()
                    wait_event.wait(timelapse)
                    wait_event.clear()
                    if not continue_thread:
                        logger.debug("not continuing capture_continuous")
                        break

            except Exception as e:
                logger.error("Got exception %s", repr(e))
            finally:
                self.state = CameraState.WAITING

    def _streamToUrl(self, url):
        global lock, wait_event, continue_thread
        with lock:
            self.state = CameraState.STREAMING
            logger.debug("streaming to url %s", url)
            self._set_normal_settings()

            try:
                # Using raspivid raspivid -o - -t 0 -vf -fps 24 -b 600000 | ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv rtmp://a.rtmp.youtube.com/live2/kfem-pm3q-598m-drfp
                # does not work with avconv it seems that it bufferizes too much
                encode_proc = subprocess.Popen(
                    "ffmpeg -re -ar 44100 -ac 2 -acodec pcm_s16le -f s16le -ac 2 -i /dev/zero -f h264 -i - -vcodec copy -acodec aac -ab 128k -g 50 -strict experimental -f flv {0}".format(
                        url).split(" "),
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                self.camera.start_recording(
                    encode_proc.stdin,
                    format='h264',
                    # The H.264 profile to use for encoding. Defaults to ‘high’, but can be one of ‘baseline’, ‘main’, ‘extended’, ‘high’, or ‘constrained’.
                    profile="main",
                    quality=self.cfg['video_quality'],
                    bitrate=self.cfg['video_bitrate'])
                print_proc_stdout(encode_proc)
                wait_event.wait()

                # try:
                #     for line in iter(encode_proc.stdout.readline, b''):
                #         logger.info(line)
                #         if encode_proc.poll() or not continue_thread:
                #             break
                #         wait_event.wait(0.5)
                #         wait_event.clear()

                # except Exception as ine:
                #     logger.error("Got exception %s", repr(ine))
                # if encode_proc.poll() is None:
                #     encode_proc.kill()

                if encode_proc.poll() is None:
                    try:
                        encode_proc.kill()
                    except Exception as e:
                        logger.debug("Could not kill video encoding %s", repr(e))

                self.camera.stop_recording()

                logger.debug("camera stopped")
            except Exception as e:
                logger.error("Got exception %s", repr(e))
            finally:
                self.state = CameraState.WAITING

    def _start_bg_task(self, name, method, **kwargs):
        global wait_event, continue_thread
        continue_thread = True
        wait_event.clear()
        bg_thread = Thread(name=name, target=method, kwargs=kwargs)
        bg_thread.daemon = True
        bg_thread.start()

    def take_timelapse(self):
        return self._start_bg_task('take_timelapse',
                                   self._take_timelapse)

    def stop_bg_task(self):
        global wait_event, continue_thread
        continue_thread = False
        wait_event.set()
        self.priority = 0

    def stream_video_to_url(self, url):
        return self._start_bg_task('stream_to_url', self._streamToUrl, url=url)

    def get_state(self):
        return "{0}".format(self.state.value)

    def toggle_stream(self, osw, params):
        if self.state == CameraState.STREAMING:
            self.stop_bg_task()
            osw.write("false".encode("utf-8"))
            osw.close()
        elif self.state == CameraState.WAITING:
            def on_done(an_osw):
                an_osw.write("true".encode("utf-8"))
                an_osw.close()
            self._doLockAndInvoke(osw, "stream_video_to_url", params, on_done)
        else:
            osw.close("Cannot do the operation the camera is currently "+self.get_state())

    def _doLockAndInvoke(self, osw, cmd, params, on_done=None):

        if not lock.acquire(2):
            osw.close("camera is busy")
            return
        try:
            self.init_camera()
            meth = getattr(self, cmd)
            if cmd == "take_picture":
                params['osw'] = osw
            meth(**params)
            if on_done:
                on_done(osw)
            else:
                osw.close()
        except Exception as e:
            logger.error("Got exception %s", repr(e))
            osw.close(repr(e))
        finally:
            lock.release()

    def invoke(self, osw, **kwargs):
        global lock
        if not 'cmd' in kwargs:
            logger.error("Missing cmd to execute")
            osw.close("Missing cmd to execute")
            return
        cmd = kwargs.pop('cmd')
        logger.debug("Invoking cmd %s", cmd)

        if cmd == "get_state":
            osw.write(self.get_state().encode())
            osw.close()
            return

        priority = 0
        if 'priority' in kwargs:
            priority = kwargs.pop('priority')

        if self.priority > priority:
            osw.close("action cannot be done, because camera is currently "+self.get_state())
            return

        if cmd == "stop_bg_task":
            self.stop_bg_task()
            osw.close()
            return

        elif cmd == "toggle_stream":
            self.toggle_stream(osw, kwargs)
            return

        self._doLockAndInvoke(osw, cmd, kwargs)
