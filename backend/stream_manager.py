import threading
import time
from typing import Dict, List

import cv2
import numpy as np

from detector import Detector

# Served when a stream has not yet produced its first frame
_PLACEHOLDER: bytes | None = None


def _get_placeholder() -> bytes:
    global _PLACEHOLDER
    if _PLACEHOLDER is None:
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(img, "Connecting...", (210, 245),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (100, 100, 100), 2)
        _, buf = cv2.imencode(".jpg", img)
        _PLACEHOLDER = buf.tobytes()
    return _PLACEHOLDER


class StreamWorker:
    def __init__(self, stream_id: str, url: str, detector: Detector,
                 inference_fps: float = 5.0):
        self.stream_id = stream_id
        self.url = url
        self._detector = detector
        self._infer_interval = 1.0 / inference_fps

        self._frame_lock = threading.Lock()
        self._latest_frame: np.ndarray | None = None
        self._latest_detections: List[dict] = []

        self._consumer_lock = threading.Lock()
        self._consumer_count = 0

        self._stop = threading.Event()

        threading.Thread(target=self._read_loop, daemon=True,
                         name=f"reader-{stream_id}").start()
        threading.Thread(target=self._infer_loop, daemon=True,
                         name=f"infer-{stream_id}").start()

    # ------------------------------------------------------------------
    # Internal threads
    # ------------------------------------------------------------------

    def _read_loop(self):
        while not self._stop.is_set():
            cap = cv2.VideoCapture(self.url)
            while not self._stop.is_set():
                ret, frame = cap.read()
                if not ret:
                    break
                with self._frame_lock:
                    self._latest_frame = frame
            cap.release()
            if not self._stop.is_set():
                time.sleep(1.0)  # brief pause before reconnect attempt

    def _infer_loop(self):
        while not self._stop.is_set():
            with self._consumer_lock:
                active = self._consumer_count > 0

            if active:
                with self._frame_lock:
                    frame = self._latest_frame
                if frame is not None:
                    detections = self._detector.detect(frame)
                    with self._frame_lock:
                        self._latest_detections = detections

            time.sleep(self._infer_interval)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_annotated_frame(self) -> bytes:
        """Return the latest frame with bounding boxes as a JPEG bytes object."""
        with self._frame_lock:
            frame = self._latest_frame
            detections = list(self._latest_detections)

        if frame is None:
            return _get_placeholder()

        out = frame.copy()
        for det in detections:
            x1, y1, x2, y2 = det["box"]
            label = f"{det['label']} {det['confidence']:.2f}"
            cv2.rectangle(out, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(out, label, (x1, max(y1 - 8, 0)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        _, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes()

    def get_detections(self) -> List[dict]:
        with self._frame_lock:
            return list(self._latest_detections)

    def add_consumer(self):
        with self._consumer_lock:
            self._consumer_count += 1

    def remove_consumer(self):
        with self._consumer_lock:
            self._consumer_count = max(0, self._consumer_count - 1)

    def stop(self):
        self._stop.set()


class StreamManager:
    def __init__(self, inference_fps: float = 5.0):
        self._detector = Detector()
        self._inference_fps = inference_fps
        self._streams: Dict[str, StreamWorker] = {}
        self._lock = threading.Lock()

    def add_stream(self, stream_id: str, url: str) -> bool:
        with self._lock:
            if stream_id in self._streams:
                return False
            self._streams[stream_id] = StreamWorker(
                stream_id, url, self._detector, self._inference_fps)
        return True

    def remove_stream(self, stream_id: str) -> bool:
        with self._lock:
            worker = self._streams.pop(stream_id, None)
        if worker:
            worker.stop()
            return True
        return False

    def get_worker(self, stream_id: str) -> StreamWorker | None:
        with self._lock:
            return self._streams.get(stream_id)

    def list_streams(self) -> List[str]:
        with self._lock:
            return list(self._streams.keys())
