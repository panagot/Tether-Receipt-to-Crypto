import { useCallback, useEffect, useId, useRef, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  /** JPEG file from live camera snapshot; parent should run extraction. */
  onCapture: (file: File) => void;
};

/**
 * Live camera "scanner" UX: preview + one tap to capture a full-resolution frame as JPEG.
 * Avoids `<input capture>` quirks where some browsers open gallery first.
 */
export function ReceiptCameraScanner({ open, onClose, onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const titleId = useId();

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    streamRef.current = null;
    s?.getTracks().forEach((t) => t.stop());
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
    }
    setReady(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopStream();
      return;
    }
    setErr(null);
    setReady(false);
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
    const v = videoRef.current;
    if (!v || v.videoWidth < 16 || v.videoHeight < 16) {
      setErr("Camera not ready yet — wait for the preview.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setErr("Could not read camera frame.");
      return;
    }
    ctx.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setErr("Could not encode JPEG.");
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

  if (!open) return null;

  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="scan-modal scan-modal--receipt">
        <div className="scan-modal__head">
          <h3 id={titleId}>Scan receipt</h3>
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
          Fill the frame, avoid glare, then tap <strong>Capture &amp; extract</strong>. Still on your network —
          the photo goes to your QVAC API for OCR.
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
        <div className="receipt-scanner__actions">
          <button type="button" className="primary receipt-scanner__snap" disabled={!ready} onClick={snapshot}>
            Capture & extract
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
