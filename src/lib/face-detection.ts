export type LocalFaceDetection = {
  faceDetected: boolean;
  confidence: number | null;
  detectorVersion: "mediapipe-blazeface-short-range-v1" | "unavailable";
};

let detectorPromise: Promise<import("@mediapipe/tasks-vision").FaceDetector> | null = null;

const publicAssetUrl = (path: string) => {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return new URL(`${base}${path.replace(/^\//, "")}`, window.location.origin).toString();
};

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(publicAssetUrl("mediapipe/wasm"));
      return FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: publicAssetUrl("models/blaze_face_short_range.tflite"),
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        // The product decision is intentionally permissive: low-quality
        // member photos should pass whenever the model can still see a face.
        minDetectionConfidence: 0.2,
        minSuppressionThreshold: 0.3,
      });
    })().catch((error) => {
      detectorPromise = null;
      throw error;
    });
  }
  return detectorPromise;
}

async function fileImage(file: File): Promise<{ source: HTMLImageElement; release: () => void }> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected image could not be read"));
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  return { source: image, release: () => URL.revokeObjectURL(objectUrl) };
}

export async function detectHumanFace(file: File): Promise<LocalFaceDetection> {
  if (typeof window === "undefined") {
    return { faceDetected: false, confidence: null, detectorVersion: "unavailable" };
  }

  let image: Awaited<ReturnType<typeof fileImage>> | null = null;
  try {
    const detector = await getDetector();
    image = await fileImage(file);
    const result = detector.detect(image.source);
    const confidence = Math.max(
      ...result.detections.map((detection) => detection.categories[0]?.score ?? 0),
      0,
    );
    return {
      faceDetected: result.detections.length > 0,
      confidence: result.detections.length > 0 ? confidence : null,
      detectorVersion: "mediapipe-blazeface-short-range-v1",
    };
  } catch (error) {
    console.warn("Local face detection was unavailable; routing to administrator review", error);
    return { faceDetected: false, confidence: null, detectorVersion: "unavailable" };
  } finally {
    image?.release();
  }
}
