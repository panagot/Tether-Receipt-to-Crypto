import { useCallback, useEffect, useId, useRef, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  /** JPEG file from live camera snapshot; parent should run extraction. */
  onCapture: (file: File) => void;
  title?: string;
};

const SAMPLE_INTERVAL_MS = 220;
const AUTO_CAPTURE_PROGRESS = 96;
const STABLE_HOLD_MS = 850;

/**
 * Live camera "scanner" UX: preview + one tap to capture a full-resolution frame as JPEG.
 * Avoids `<input capture>` quirks where some browsers open gallery first.
 */
export function ReceiptCameraScanner({ open, onClose, onCapture, title = "Scan receipt" }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const targetProgressRef = useRef(0);
  const stableMsRef = useRef(0);
  const captureFiredRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scanHint, setScanHint] = useState("Hold steady, reduce glare.");
  const titleId = useId();

  const stopStream = useCallback(() => {
    if (sampleTimerRef.current !== null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    const s = streamRef.current;
    streamRef.current = null;
    s?.getTracks().forEach((t) => t.stop());
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
    }
    prevLumaRef.current = null;
    targetProgressRef.current = 0;
    stableMsRef.current = 0;
    setReady(false);
    setProgress(0);
    setScanHint("Hold steady, reduce glare.");
  }, []);

  useEffect(() => {
    if (!open) {
      stopStream();
      return;
    }
    setErr(null);
    setReady(false);
    setProgress(0);
    setScanHint("Hold steady, reduce glare.");
    captureFiredRef.current = false;
    stableMsRef.current = 0;
    targetProgressRef.current = 0;
    prevLumaRef.current = null;
    let cancelled = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr("Camera API not available in this browser.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
          setReady(true);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Could not open camera");
        }
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open, stopStream]);

  const snapshot = useCallback(() => {
    if (captureFiredRef.current) return;
    captureFiredRef.current = true;
    const v = videoRef.current;
    if (!v || v.videoWidth < 16 || v.videoHeight < 16) {
      setErr("Camera not ready yet — wait for the preview.");
      captureFiredRef.current = false;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setErr("Could not read camera frame.");
      captureFiredRef.current = false;
      return;
    }
    ctx.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setErr("Could not encode JPEG.");
          captureFiredRef.current = false;
          return;
        }
        const file = new File([blob], `receipt-scan-${Date.now()}.jpg`, {
          type: "image/jpeg",
          lastModified: Date.now(),
        });
        stopStream();
        onCapture(file);
      },
      "image/jpeg",
      0.92
    );
  }, [onCapture, stopStream]);

  useEffect(() => {
    if (!open || !ready || err) return;
    const video = videoRef.current;
    if (!video) return;

    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement("canvas");
    }
    const canvas = analysisCanvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const sample = () => {
      if (captureFiredRef.current) return;
      const v = videoRef.current;
      if (!v || v.videoWidth < 40 || v.videoHeight < 40) return;

      const sampleW = 160;
      const sampleH = Math.max(120, Math.round((sampleW * v.videoHeight) / Math.max(v.videoWidth, 1)));
      if (canvas.width !== sampleW || canvas.height !== sampleH) {
        canvas.width = sampleW;
        canvas.height = sampleH;
      }

      ctx.drawImage(v, 0, 0, sampleW, sampleH);
      const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
      const pxCount = sampleW * sampleH;
      const lumas = new Uint8Array(pxCount);
      let sum = 0;
      let sumSq = 0;
      let sharpnessAcc = 0;

      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        lumas[p] = y;
        sum += y;
        sumSq += y * y;
      }

      for (let y = 1; y < sampleH; y += 2) {
        for (let x = 1; x < sampleW; x += 2) {
          const idx = y * sampleW + x;
          sharpnessAcc += Math.abs(lumas[idx] - lumas[idx - 1]) + Math.abs(lumas[idx] - lumas[idx - sampleW]);
        }
      }

      const mean = sum / pxCount;
      const variance = Math.max(0, sumSq / pxCount - mean * mean);
      const stdDev = Math.sqrt(variance);
      const sharpness = sharpnessAcc / Math.max(1, ((sampleW / 2) * (sampleH / 2) * 2));

      const brightnessScore = Math.max(0, 1 - Math.abs(mean - 145) / 120);
      const contrastScore = Math.min(1, stdDev / 58);
      const sharpnessScore = Math.min(1, sharpness / 22);

      let motion = 0;
      const prev = prevLumaRef.current;
      if (prev && prev.length === lumas.length) {
        let diff = 0;
        for (let i = 0; i < lumas.length; i += 6) {
          diff += Math.abs(lumas[i] - prev[i]);
        }
        motion = diff / (Math.ceil(lumas.length / 6) * 255);
      }
      prevLumaRef.current = lumas;
      const stabilityScore = Math.max(0, 1 - motion * 4.5);

      const frameScore =
        brightnessScore * 0.24 + contrastScore * 0.24 + sharpnessScore * 0.22 + stabilityScore * 0.3;
      const isGoodFrame = frameScore >= 0.62;

      targetProgressRef.current = Math.max(0, Math.min(100, targetProgressRef.current + (isGoodFrame ? 7.5 : -5.5)));
      setProgress((prevProgress) => {
        const blended = prevProgress * 0.7 + targetProgressRef.current * 0.3;
        return Math.max(0, Math.min(100, blended));
      });

      if (brightnessScore < 0.45) {
        setScanHint("Increase light and avoid dark shadows.");
      } else if (contrastScore < 0.4) {
        setScanHint("Reduce glare and improve contrast.");
      } else if (stabilityScore < 0.45) {
        setScanHint("Hold steady for auto-capture.");
      } else {
        setScanHint("Great framing - keep steady.");
      }

      if (isGoodFrame && targetProgressRef.current >= AUTO_CAPTURE_PROGRESS) {
        stableMsRef.current += SAMPLE_INTERVAL_MS;
      } else {
        stableMsRef.current = Math.max(0, stableMsRef.current - SAMPLE_INTERVAL_MS / 2);
      }

      if (!captureFiredRef.current && stableMsRef.current >= STABLE_HOLD_MS) {
        snapshot();
      }
    };

    sampleTimerRef.current = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, [err, open, ready, snapshot]);

  if (!open) return null;

  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="scan-modal scan-modal--receipt">
        <div className="scan-modal__head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="scan-modal__close"
            onClick={() => {
              stopStream();
              onClose();
            }}
          >
            Close
          </button>
        </div>
        <p className="scan-modal__hint">
          Fill the frame and hold steady. Auto-capture runs when quality is high; manual capture stays available.
        </p>
        <div className="receipt-scanner__video-wrap">
          <video
            ref={videoRef}
            className="receipt-scanner__video"
            playsInline
            muted
            autoPlay
            aria-label="Camera preview"
          />
          {!ready && !err && <div className="receipt-scanner__loading">Starting camera…</div>}
        </div>
        {err && <p className="err receipt-scanner__err">{err}</p>}
        <div className="receipt-scanner__progress" aria-live="polite">
          <div className="receipt-scanner__progress-row">
            <span>Scan progress</span>
            <strong>{Math.round(progress)}%</strong>
          </div>
          <div
            className="receipt-scanner__progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <div className="receipt-scanner__progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="receipt-scanner__progress-hint">{scanHint}</p>
        </div>
        <div className="receipt-scanner__actions">
          <button type="button" className="primary receipt-scanner__snap" disabled={!ready} onClick={snapshot}>
            Capture now
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              stopStream();
              onClose();
            }}
          >
            Cancel
          </button>
        </div>
        <p className="receipt-scanner__fallback">
          Camera blocked?{" "}
          <button type="button" className="linkish" onClick={() => fallbackInputRef.current?.click()}>
            Use system camera / gallery
          </button>
          <input
            ref={fallbackInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) {
                stopStream();
                onCapture(f);
              }
            }}
          />
        </p>
      </div>
    </div>
  );
}
