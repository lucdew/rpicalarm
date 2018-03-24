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

logger = logging.getLogger()


lock = Lock()
wait_event = Event()
continue_thread = False


class Camera(object):
    def __init__(self):
        pass

    def takePictureCmd(self, osw, width, height, v_flip=False, h_flip=False):
        global lock
        logger.debug("Taking picture w=%s,h=%s", width, height)
        with lock:
            with picamera.PiCamera(resolution=(width, height)) as camera:
                try:
                    #camera.resolution = (1024, 768)
                    camera.start_preview()
                    # Camera warm-up time
                    time.sleep(1)
                    if v_flip:
                        camera.vflip = True
                    if h_flip:
                        camera.hflip = True
                    #camera.capture(osw, 'jpeg', resize=(width, height))
                    camera.capture(osw, 'jpeg')
                except Exception as e:
                    logger.error("Got exception %s", repr(e))
                finally:
                    camera.stop_preview()
                    osw.close()

    def _takeTimelapseCmd(self,
                          width,
                          height,
                          prefix,
                          save_path,
                          v_flip=False,
                          h_flip=False,
                          timelapse=10):
        global continue_thread, wait_event, lock
        with lock:
            logger.debug("starting timelapse")
            with picamera.PiCamera() as camera:
                camera.start_preview()
                try:
                    camera.resolution = (width, height)
                    if v_flip:
                        camera.vflip = True
                    if h_flip:
                        camera.hflip = True

                    time.sleep(1)

                    stream = io.BytesIO()

                    for _ in camera.capture_continuous(
                            stream, 'jpeg'):

                        file_name = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S.jpg')
                        stream.seek(0)

                        logger.debug('Writing picture %s', file_name)

                        tmp_file = os.path.join(save_path, "_{0}".format(file_name))

                        with open(tmp_file, 'wb') as f:
                            f.write(stream.read())

                        os.rename(tmp_file, os.path.join(save_path, file_name))

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
                    camera.stop_preview()

    def _streamToUrl(self, width, height, quality, url):
        global wait_event, lock
        with lock:
            logger.debug("streaming to url")
            with picamera.PiCamera(
                    resolution=(width, height), framerate=25) as camera:
                try:
                    ffmpeg = subprocess.Popen(
                        ['ffmpeg', '-i', '-', '-vcodec', 'copy', '-an', url],
                        stdin=subprocess.PIPE)
                    camera.start_recording(
                        ffmpeg,
                        format='h264',
                        quality=quality,
                        bitrate=2000000)
                    wait_event.wait()
                    ffmpeg.kill()
                    camera.stop_recording()
                except Exception as e:
                    logger.error("Got exception %s", repr(e))

    def startBackgroundTask(self, name, method, osw, **kwargs):
        global lock, wait_event, continue_thread
        if not lock.acquire(2):
            osw.close(status=False)
            return
        try:
            continue_thread = True
            wait_event.clear()
            take_timelapse_thread = Thread(name=name, target=method, kwargs=kwargs)
            take_timelapse_thread.daemon = True
            take_timelapse_thread.start()
            osw.close()
        finally:
            lock.release()

    def takeTimelapseCmd(self, osw, **kwargs):
        return self.startBackgroundTask('take_timelapse',
                                        self._takeTimelapseCmd, osw, **kwargs)

    def stopBackgroundTask(self, osw):
        global wait_event, continue_thread
        continue_thread = False
        wait_event.set()
        osw.close()

    def streamVideoToUrl(self, osw, **kwargs):
        return self.startBackgroundTask('stream_to_url', self._streamToUrl,
                                        osw, **kwargs)
