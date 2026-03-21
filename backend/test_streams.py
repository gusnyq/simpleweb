"""
Fake MJPEG stream server for testing.

Serves N synthetic camera streams on a single port:
  http://localhost:<port>/stream/0
  http://localhost:<port>/stream/1
  ...

Usage:
  python test_streams.py                  # 4 streams on port 9001
  python test_streams.py --count 8        # 8 streams
  python test_streams.py --port 9002      # different port
  python test_streams.py --video foo.mp4  # loop a real video file instead
"""

import argparse
import math
import time

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

COLORS = [
    (220,  80,  80),
    ( 80, 220,  80),
    ( 80,  80, 220),
    (220, 220,  80),
    (220,  80, 220),
    ( 80, 220, 220),
    (200, 140,  60),
    (140,  60, 200),
]

args: argparse.Namespace  # set at startup


def _synthetic_frames(index: int, width=640, height=480, fps=25):
    t0 = time.monotonic()
    frame_interval = 1.0 / fps
    while True:
        t = time.monotonic() - t0
        frame = np.full((height, width, 3), (20, 20, 30), dtype=np.uint8)

        # Moving filled circle
        cx = int(width  / 2 + math.sin(t + index * 1.1) * width  * 0.35)
        cy = int(height / 2 + math.cos(t * 0.7 + index * 0.9) * height * 0.35)
        color = COLORS[index % len(COLORS)]
        cv2.circle(frame, (cx, cy), 50, color, -1)

        # Labels
        cv2.putText(frame, f"Test stream {index}", (10, 34),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (210, 210, 210), 2)
        cv2.putText(frame, f"t = {t:6.1f} s", (10, 64),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (150, 150, 150), 1)

        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
        time.sleep(frame_interval)


def _video_frames(index: int, path: str, fps=25):
    """Loop a video file indefinitely."""
    frame_interval = 1.0 / fps
    while True:
        cap = cv2.VideoCapture(path)
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            # Label with stream index so multiple streams look distinct
            cv2.putText(frame, f"Stream {index}", (10, 34),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            time.sleep(frame_interval)
        cap.release()


@app.get("/stream/{index}")
def stream(index: int):
    if index < 0 or index >= args.count:
        from fastapi import HTTPException
        raise HTTPException(404, f"Stream index must be 0–{args.count - 1}")

    if args.video:
        gen = _video_frames(index, args.video)
    else:
        gen = _synthetic_frames(index)

    return StreamingResponse(gen, media_type="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fake MJPEG stream server")
    parser.add_argument("--count", type=int, default=4,
                        help="Number of streams to serve (default: 4)")
    parser.add_argument("--port", type=int, default=9001,
                        help="Port to listen on (default: 9001)")
    parser.add_argument("--video", type=str, default="",
                        help="Path to a video file to loop (default: synthetic)")
    args = parser.parse_args()

    source = f"video file '{args.video}'" if args.video else "synthetic frames"
    print(f"Serving {args.count} streams ({source}) on port {args.port}")
    for i in range(args.count):
        print(f"  http://localhost:{args.port}/stream/{i}")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
