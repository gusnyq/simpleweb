#!/usr/bin/env bash

BACKEND_PORT=8000
STREAMS_PORT=9001
STREAM_COUNT=2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $(jobs -p) 2>/dev/null
}
trap cleanup INT TERM EXIT

# Start backend (must run from backend/ so local imports resolve)
echo "Starting backend on port $BACKEND_PORT..."
(cd "$SCRIPT_DIR/backend" && uvicorn main:app --host 0.0.0.0 --port $BACKEND_PORT --log-level warning) &

# Start fake stream server
echo "Starting $STREAM_COUNT test streams on port $STREAMS_PORT..."
python "$SCRIPT_DIR/backend/test_streams.py" --count $STREAM_COUNT --port $STREAMS_PORT &

# Wait for backend to accept requests
printf "Waiting for backend"
until curl -sf "http://localhost:$BACKEND_PORT/api/streams" >/dev/null 2>&1; do
  printf "."
  sleep 0.5
done
echo " ready."

# Register streams into the backend
# Each entry: "id|mjpeg_url|waypoints_url"
STREAMS=(
  "cam0|http://localhost:$STREAMS_PORT/stream/0|http://localhost:8989/upload_waypoints"
  "cam1|http://localhost:$STREAMS_PORT/stream/1|http://localhost:8989/upload_waypoints"
)

echo "Registering streams..."
for entry in "${STREAMS[@]}"; do
  IFS='|' read -r id mjpeg_url waypoints_url <<< "$entry"
  curl -sf -X POST "http://localhost:$BACKEND_PORT/api/streams" \
    -H "Content-Type: application/json" \
    -d "{\"id\": \"$id\", \"url\": \"$mjpeg_url\", \"waypoints_url\": \"$waypoints_url\"}" >/dev/null
  echo "  $id -> $mjpeg_url (waypoints: $waypoints_url)"
done

echo ""
echo "Open http://localhost:$BACKEND_PORT"
echo "Press Ctrl+C to stop all services."
echo ""

wait
