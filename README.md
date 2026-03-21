# simpleweb

Live MJPEG stream viewer with real-time object detection (YOLOv8), designed for Gazebo camera topics.

## Architecture

```
Gazebo → web_video_server → MJPEG streams
                                 ↓
              Python FastAPI backend
              ├── Thread per stream: read → YOLO → draw boxes → re-encode
              ├── GET /stream/{id}       → annotated MJPEG
              └── GET /api/detections/{id} → latest detections (JSON)
                                 ↓
              Simple HTML frontend
              ├── <img> per stream (annotated, live)
              └── Detection badges updated via polling
```

Each stream gets two daemon threads: one reading frames from the source MJPEG URL, one running YOLOv8 at a configurable rate. Bounding boxes from the last inference cycle are overlaid on every outgoing frame, decoupling detection rate from display rate. Inference pauses automatically when no client is watching.

## Project layout

```
simpleweb/
├── backend/
│   ├── main.py            # FastAPI app, all endpoints
│   ├── stream_manager.py  # per-stream read + infer threads
│   ├── detector.py        # YOLOv8 wrapper
│   ├── test_streams.py    # fake MJPEG server for testing
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```

## Testing without Gazebo

`test_streams.py` runs a fake MJPEG server that generates synthetic moving-shape streams, useful for verifying the UI and stream infrastructure before connecting real hardware.

```bash
# Terminal 1 — main app
cd backend && uvicorn main:app --port 8000

# Terminal 2 — fake streams (4 streams on port 9001)
cd backend && python test_streams.py --count 4
```

Then add streams in the UI using URLs like `http://localhost:9001/stream/0`, `http://localhost:9001/stream/1`, etc.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--count` | `4` | Number of streams |
| `--port` | `9001` | Port |
| `--video foo.mp4` | — | Loop a real video file (enables detection testing) |

> Note: YOLO won't detect anything in synthetic frames. Use `--video` with a real clip containing people, vehicles, etc. to test detection.

## Setup

### 1. Expose Gazebo cameras as MJPEG

Install and run the ROS `web_video_server` package. By default it serves streams at:

```
http://<host>:8080/stream?topic=<ros_topic>
```

### 2. Start the backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

On first run, YOLOv8 will download the `yolov8n.pt` weights (~6 MB) automatically.

Open `http://localhost:8000` in your browser.

## Usage

Use the form at the top of the page to add streams, or use the API directly:

```bash
# Add a stream
curl -X POST http://localhost:8000/api/streams \
  -H "Content-Type: application/json" \
  -d '{"id": "cam0", "url": "http://localhost:8080/stream?topic=/camera/image_raw"}'

# List active streams
curl http://localhost:8000/api/streams

# Get latest detections for a stream
curl http://localhost:8000/api/detections/cam0

# Remove a stream
curl -X DELETE http://localhost:8000/api/streams/cam0
```

## Tuning

| Parameter | Location | Default |
|-----------|----------|---------|
| Inference FPS | `StreamManager(inference_fps=...)` in `main.py` | `5.0` |
| YOLO model | `Detector(model=...)` in `stream_manager.py` | `yolov8n.pt` |
| Detection confidence threshold | `Detector(confidence=...)` in `stream_manager.py` | `0.5` |
| Output stream FPS cap | `_mjpeg_frames(max_fps=...)` in `main.py` | `25.0` |
| JPEG output quality | `cv2.IMWRITE_JPEG_QUALITY` in `stream_manager.py` | `80` |

## Drawbacks / known trade-offs

- **Bounding boxes lag on fast motion** — inference runs at a lower rate than the display FPS. Last known detections are overlaid on every frame.
- **All stream traffic routes through the backend** — the backend acts as a proxy, which adds latency and CPU overhead compared to pointing the browser directly at `web_video_server`. Acceptable on a local network.
- **CPU load scales with camera count** — 20 cameras at 5 inference FPS = 100 YOLO calls/sec on CPU. Use a GPU or reduce `inference_fps` if needed.
- **No detection history** — results are ephemeral. Add a database or log file to `detector.py` if persistence is needed.
