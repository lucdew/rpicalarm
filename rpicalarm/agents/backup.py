# -*- coding: utf-8 -*-

from pathlib import Path
import os
from os import path
import logging

from watchdog.observers import Observer
from watchdog.events import PatternMatchingEventHandler, EVENT_TYPE_MOVED, EVENT_TYPE_MODIFIED
import cloudinary
import cloudinary.uploader

from .. import events, run_async, getLogger

getLogger("watchdog").setLevel(logging.ERROR)
LOGGER = getLogger(__name__)


def extract_metatada(src_path):
    elts = path.basename(src_path).split("_")
    if len(elts) < 2:
        return None
    return FileMetaData(elts[1], elts[0])


class FileMetaData(object):

    def __init__(self, date, session_id):
        self.date_text = date
        self.session_id = session_id

    def __repr__(self):
        return str(self.__dict__)


class CloudinaryBackuper(object):

    def __init__(self, **cfg):
        cloudinary.config(**cfg)

    def backup(self, file_path, file_metadata):
        file_tags = self.compute_tag(file_metadata.session_id)
        LOGGER.debug("Cloudinary backup %s", file_metadata)
        cloudinary.uploader.upload_image(file_path, tags=file_tags)
        LOGGER.debug("Cloudinary backup done of %s", file_metadata)

    def clean(self, session_id):
        file_tags = self.compute_tag(session_id)
        LOGGER.debug("Cloudinary delete of %s", file_tags)
        cloudinary.api.delete_resources_by_tag(file_tags)
        LOGGER.debug("Cloudinary delete done of %s", file_tags)

    def compute_tag(self, session_id):
        return "rpicalarm-{0}".format(session_id)

    @property
    def name(self):
        return "cloudindary"


class Backuper(PatternMatchingEventHandler):

    def __init__(self, sync_dir, cloudinary_cfg=None):
        self.backupers = []
        self.observer = None

        if cloudinary_cfg:
            self.backupers.append(CloudinaryBackuper(**cloudinary_cfg))

        self.sync_dir = sync_dir
        super().__init__(patterns=["**/camera*.jpg"], ignore_directories=True)

        self._register_events_handlers()
        self._sync()

    def _register_events_handlers(self):
        events.authentication_succeeded += self.on_authentication_succeeded

    def on_any_event(self, event):
        # Camera writes the file continously and rpicalaram camera module renames it when done
        if event.event_type == EVENT_TYPE_MOVED:
            file_path = event.dest_path
        elif event.event_type == EVENT_TYPE_MODIFIED:
            file_path = event.src_path
        else:
            pass

        LOGGER.debug("Got file creation event %s", file_path)
        file_metadata = extract_metatada(file_path)
        has_at_least_one_succeeded = True
        if file_metadata:
            for backuper in self.backupers:
                try:
                    backuper.backup(file_path, file_metadata)
                    has_at_least_one_succeeded = True
                except Exception:
                    LOGGER.exception("Failed backing up %s with backuper %s",
                                     file_path, backuper.name)
        if has_at_least_one_succeeded:
            try:
                os.unlink(file_path)
            except Exception:
                LOGGER.exception("Failed deleting file %s", file_path)

    def _sync(self):
        sync_dir_path = Path(self.sync_dir)
        if not sync_dir_path.exists():
            raise Exception("sync dir {0} does not exist".format(self.sync_dir))

        LOGGER.info("Monitoring directory %s", self.sync_dir)
        observer = Observer()
        self.observer = observer
        image_paths = Path(self.sync_dir).glob("camera*.jpg")
        observer.schedule(self, self.sync_dir, recursive=True)
        observer.start()
        self._consume_remaining_files(image_paths)

    @run_async
    def _consume_remaining_files(self, image_paths):
        for image_p in image_paths:
            LOGGER.debug("Touching unconsumed file %s", str(image_p))
            image_p.touch()

    @run_async
    def on_authentication_succeeded(self, _origin, session):

        LOGGER.info("Cleaning up saved images of session %s", session.id)
        for backuper in self.backupers:
            try:
                backuper.clean(session.id)
            except Exception:
                LOGGER.exception("Failed cleaning up images with tag %s", session.id)

        for file in os.scandir(self.sync_dir):
            if file.name.startswith("camera_"+session.id) and file.name.endswith(".jpg"):
                os.unlink(file.path)
