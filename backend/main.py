import time
from pathlib import Path
from typing import List

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from stream_manager import StreamManager

app = FastAPI(title="MJPEG Object Detection")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = StreamManager(inference_fps=5.0)
_waypoints_urls: dict[str, str] = {}

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class StreamConfig(BaseModel):
    id: str
    url: str
    waypoints_url: str = ""

class WaypointPayload(BaseModel):
    points: List[List[float]]

# ---------------------------------------------------------------------------
# Stream management endpoints
# ---------------------------------------------------------------------------

@app.get("/api/streams")
def list_streams():
    return manager.list_streams()


@app.post("/api/streams", status_code=201)
def add_stream(cfg: StreamConfig):
    if not manager.add_stream(cfg.id, cfg.url):
        raise HTTPException(400, detail="Stream ID already exists")
    _waypoints_urls[cfg.id] = cfg.waypoints_url
    return {"status": "added", "id": cfg.id}


@app.delete("/api/streams/{stream_id}")
def remove_stream(stream_id: str):
    if not manager.remove_stream(stream_id):
        raise HTTPException(404, detail="Stream not found")
    _waypoints_urls.pop(stream_id, None)
    return {"status": "removed"}


@app.get("/api/detections/{stream_id}")
def get_detections(stream_id: str):
    worker = manager.get_worker(stream_id)
    if not worker:
        raise HTTPException(404, detail="Stream not found")
    return worker.get_detections()

# ---------------------------------------------------------------------------
# Waypoints proxy endpoint
# ---------------------------------------------------------------------------

@app.post("/api/waypoints/{stream_id}")
async def upload_waypoints(stream_id: str, payload: WaypointPayload):
    waypoints_url = _waypoints_urls.get(stream_id)
    if not waypoints_url:
        raise HTTPException(404, detail="No waypoints URL registered for this stream")
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(waypoints_url, json=payload.model_dump(), timeout=10.0)
            resp.raise_for_status()
        except httpx.RequestError as e:
            raise HTTPException(502, detail=f"Could not reach waypoint service: {e}")
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, detail=e.response.text)
    return {"status": "ok"}

# ---------------------------------------------------------------------------
# MJPEG streaming endpoint
# ---------------------------------------------------------------------------

def _mjpeg_frames(stream_id: str, max_fps: float = 25.0):
    worker = manager.get_worker(stream_id)
    if worker is None:
        return

    frame_interval = 1.0 / max_fps
    worker.add_consumer()
    try:
        while True:
            t0 = time.monotonic()
            jpeg = worker.get_annotated_frame()
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + jpeg +
                b"\r\n"
            )
            elapsed = time.monotonic() - t0
            sleep_time = frame_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)
    finally:
        worker.remove_consumer()


@app.get("/stream/{stream_id}")
def stream(stream_id: str):
    if not manager.get_worker(stream_id):
        raise HTTPException(404, detail="Stream not found")
    return StreamingResponse(
        _mjpeg_frames(stream_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )

# ---------------------------------------------------------------------------
# Telemetry endpoint
# ---------------------------------------------------------------------------

@app.get("/api/telemetry/{stream_id}")
def get_telemetry(stream_id: str):
    if not manager.get_worker(stream_id):
        raise HTTPException(404, detail="Stream not found")
    # TODO: replace with real data sources (ROS topics, k8s API, etc.)
    return {
        "battery": None,
        "pods": [],
        "status": "online",
        "gps": {"lat": 37.7749, "lon": -122.4194},
    }

# ---------------------------------------------------------------------------
# Serve frontend (must be last — catch-all)
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
