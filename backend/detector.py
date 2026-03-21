from ultralytics import YOLO


class Detector:
    def __init__(self, model: str = "yolov8n.pt", confidence: float = 0.5):
        self.model = YOLO(model)
        self.confidence = confidence

    def detect(self, frame) -> list[dict]:
        results = self.model(frame, conf=self.confidence, verbose=False)[0]
        out = []
        for box in results.boxes:
            cls = int(box.cls[0])
            out.append({
                "label": results.names[cls],
                "confidence": round(float(box.conf[0]), 3),
                "box": list(map(int, box.xyxy[0].tolist())),
            })
        return out
