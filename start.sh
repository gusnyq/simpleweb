#!/usr/bin/env bash

BACKEND_PORT=8000
STREAMS_PORT=9001
STREAM_COUNT=4

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
echo "Registering streams..."
for i in $(seq 0 $((STREAM_COUNT - 1))); do
  curl -sf -X POST "http://localhost:$BACKEND_PORT/api/streams" \
    -H "Content-Type: application/json" \
    -d "{\"id\": \"cam$i\", \"url\": \"http://localhost:$STREAMS_PORT/stream/$i\"}" >/dev/null
  echo "  cam$i -> http://localhost:$STREAMS_PORT/stream/$i"
done

echo ""
echo "Open http://localhost:$BACKEND_PORT"
echo "Press Ctrl+C to stop all services."
echo ""

wait
