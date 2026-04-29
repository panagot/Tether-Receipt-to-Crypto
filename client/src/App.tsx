import { Html5Qrcode } from "html5-qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, getApiOrigin } from "./apiBase";
import { parseJsonOrThrow } from "./apiJson";
import { ComicHeroIllustration } from "./ComicHeroIllustration";
import { explorerTxUrl } from "./explorerTx";
import { ReceiptCameraScanner } from "./ReceiptCameraScanner";
import { isValidSolanaRecipient, parseRecipientFromScanOrPaste } from "./solanaRecipient";

const SETTLEMENT_LS = "rtc:settlement-v1";
const AUTO_EXTRACT_LS = "rtc:auto-extract-v1";
/** RFC MIME + common quirks (e.g. `image/jpg` from some Windows pickers). */
const ALLOWED_RECEIPT_IMAGE = /^image\/(jpeg|jpg|jpe|pjpeg|png|webp)$/i;
/** First QVAC run can download large models; keep below typical proxy limits. */
const EXTRACT_TIMEOUT_MS = 20 * 60 * 1000;

function isAllowedReceiptFile(f: File): boolean {
  if (ALLOWED_RECEIPT_IMAGE.test(f.type)) return true;
  const n = f.name.toLowerCase();
  const extOk = /\.(jpe?g|png|webp)$/.test(n);
  if (!extOk) return false;
  if (!f.type || f.type === "application/octet-stream") return true;
  return false;
}

function sanitizeHealthDetail(detail: string | null): string | null {
  if (!detail) return null;
  if (/upstream request failed/i.test(detail) && /ENOTFOUND/i.test(detail)) {
    return (
      "Upstream host DNS lookup failed (likely an expired tunnel URL). " +
      "Update RTC_API_PROXY_TARGET to a live HTTPS origin and redeploy."
    );
  }
  return detail;
}

type ApiHealth = {
  ok?: boolean;
  solanaCluster?: string;
  solanaClusterLabel?: string;
  walletReady?: boolean;
  payerAddress?: string | null;
  node?: string;
};

type ReceiptSearchHit = {
  id: string;
  at: string;
  merchant: string;
  total: number;
  category: string;
  preview: string;
  score: number;
};

type Extraction = {
  merchant: string;
  total: number;
  currency: string;
  date?: string;
  lineItems?: Array<{
    description: string;
    quantity?: number;
    unitPrice?: number;
    total?: number;
  }>;
  category: string;
  confidence: number;
  notes?: string;
};

/** Matches `/api/extract` `settlementFx` when the receipt currency needed FX for the USDT hint. */
type SettlementFx = {
  from: string;
  to: string;
  rate: number;
  source: "env" | "frankfurter" | "fallback" | "unmapped";
  asOf?: string;
};

type ExtractDebugPayload = {
  timings: { prepareMs: number; ocrMs: number; extractMs: number };
  ocrCharCount: number;
  ocrLangsUsed: string[];
  ocrSignalScore?: number;
  ocrRetryCount?: number;
};

type PosExtraction = {
  ocrText: string;
  amount: number;
  currency: string;
  confidence: number;
  extractDebug?: unknown;
};

function normalizeReceiptCurrency(currency: string): string {
  const c = currency.trim().toUpperCase().replace(/\s+/g, "");
  if (c === "EURO") return "EUR";
  return c;
}

function usdtBaseUnitsFromTotal(total: number, currency: string, fx: SettlementFx | null): number {
  if (!Number.isFinite(total) || total < 0) return 0;
  const c = normalizeReceiptCurrency(currency);
  if (c === "USD" || c === "USDT") return Math.round(total * 1e6);
  if (
    fx &&
    fx.from === c &&
    fx.to === "USD" &&
    Number.isFinite(fx.rate) &&
    fx.rate > 0
  ) {
    return Math.round(total * fx.rate * 1e6);
  }
  return Math.round(total * 1e6);
}

function formatUsdFromMicroUsdt(baseUnits: number | null): string | null {
  if (baseUnits == null || !Number.isFinite(baseUnits)) return null;
  const n = baseUnits / 1e6;
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function UploadIcon() {
  return (
    <svg className="drop__icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M24 8v20M14 22l10-10 10 10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 34h28"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.35"
      />
    </svg>
  );
}

function readSettlementDraft(): { recipient?: string; memo?: string; amountBase?: string } | null {
  try {
    const raw = localStorage.getItem(SETTLEMENT_LS);
    if (!raw) return null;
    return JSON.parse(raw) as { recipient?: string; memo?: string; amountBase?: string };
  } catch {
    return null;
  }
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [settlementFx, setSettlementFx] = useState<SettlementFx | null>(null);
  const [suggestedUsdtUsd, setSuggestedUsdtUsd] = useState<number | null>(null);
  const [extractDebug, setExtractDebug] = useState<ExtractDebugPayload | null>(null);
  const [suggestedBase, setSuggestedBase] = useState<number | null>(null);
  const [recipient, setRecipient] = useState(() => readSettlementDraft()?.recipient ?? "");
  const [amountBase, setAmountBase] = useState(() => readSettlementDraft()?.amountBase ?? "");
  const [memo, setMemo] = useState(() => readSettlementDraft()?.memo ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [payLoading, setPayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payResult, setPayResult] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [healthLoad, setHealthLoad] = useState<"loading" | "ok" | "error">("loading");
  const [healthDetail, setHealthDetail] = useState<string | null>(null);
  const [navHint, setNavHint] = useState<string | null>(null);
  const [sigCopied, setSigCopied] = useState(false);
  const [previewLoadError, setPreviewLoadError] = useState<string | null>(null);
  const [extractSlowHint, setExtractSlowHint] = useState(false);
  /** After taking a photo with the device camera, run extraction once the file is in state. */
  const [autoExtractAfterCamera, setAutoExtractAfterCamera] = useState(false);
  const [receiptScannerOpen, setReceiptScannerOpen] = useState(false);
  const [posScannerOpen, setPosScannerOpen] = useState(false);
  const [posFile, setPosFile] = useState<File | null>(null);
  const [posPreviewUrl, setPosPreviewUrl] = useState<string | null>(null);
  const [posLoading, setPosLoading] = useState(false);
  const [posExtraction, setPosExtraction] = useState<PosExtraction | null>(null);
  const [posError, setPosError] = useState<string | null>(null);
  const [autoExtractOnUpload, setAutoExtractOnUpload] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_EXTRACT_LS) === "1";
    } catch {
      return false;
    }
  });
  const [isDesktopLayout, setIsDesktopLayout] = useState(
    () => (typeof window !== "undefined" ? window.matchMedia("(min-width: 721px)").matches : true)
  );
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ReceiptSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const qrRunnerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    if (!loading) {
      setExtractSlowHint(false);
      return;
    }
    setExtractSlowHint(false);
    const id = window.setTimeout(() => setExtractSlowHint(true), 10_000);
    return () => window.clearTimeout(id);
  }, [loading]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 721px)");
    const sync = () => setIsDesktopLayout(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setHealthLoad("loading");
    setHealthDetail(null);
    void (async () => {
      try {
        const r = await fetch(apiUrl("/api/health"));
        const j = await parseJsonOrThrow<ApiHealth & { error?: string }>(r);
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setHealth(j);
        setHealthDetail(null);
        setHealthLoad("ok");
      } catch (e) {
        setHealth(null);
        setHealthDetail(e instanceof Error ? e.message : String(e));
        setHealthLoad("error");
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTLEMENT_LS, JSON.stringify({ recipient, memo, amountBase }));
    } catch {
      /* ignore quota */
    }
  }, [recipient, memo, amountBase]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_EXTRACT_LS, autoExtractOnUpload ? "1" : "0");
    } catch {
      /* ignore quota */
    }
  }, [autoExtractOnUpload]);

  const onFile = useCallback((f: File | null, opts?: { fromCamera?: boolean }) => {
    setPreviewLoadError(null);
    setAutoExtractAfterCamera(false);
    if (f && !isAllowedReceiptFile(f)) {
      setPreviewUrl((prevUrl) => {
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        return null;
      });
      setFile(null);
      setError(
        f.type === "image/heic" || f.name.toLowerCase().endsWith(".heic")
          ? "HEIC photos are not supported in the browser preview. Export as JPEG or PNG, then upload."
          : `Unsupported image type (${f.type || "unknown"}). Use JPEG, PNG, or WebP.`
      );
      return;
    }
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return f ? URL.createObjectURL(f) : null;
    });
    setFile(f);
    setExtraction(null);
    setSettlementFx(null);
    setSuggestedUsdtUsd(null);
    setExtractDebug(null);
    setOcrText("");
    setSuggestedBase(null);
    setPayResult(null);
    setError(null);
    if (f && (opts?.fromCamera || autoExtractOnUpload)) {
      setAutoExtractAfterCamera(true);
    }
  }, [autoExtractOnUpload]);

  const clearReceipt = useCallback(() => {
    onFile(null);
    setConfirmed(false);
  }, [onFile]);

  const onPosFile = useCallback((f: File | null) => {
    setPosPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return f ? URL.createObjectURL(f) : null;
    });
    setPosFile(f);
    setPosExtraction(null);
    setPosError(null);
  }, []);

  const openReceiptPicker = useCallback(() => {
    document.getElementById("file")?.click();
  }, []);

  const goToSection = useCallback((id: string, hintIfMissing?: string) => {
    const el = document.getElementById(id);
    if (el) {
      setNavHint(null);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (hintIfMissing) setNavHint(hintIfMissing);
    document.getElementById("workflow")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const extract = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setPayResult(null);
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), EXTRACT_TIMEOUT_MS);
    try {
      const fd = new FormData();
      fd.append("receipt", file);
      const r = await fetch(apiUrl("/api/extract"), { method: "POST", body: fd, signal: ac.signal });
      const j = await parseJsonOrThrow<{
        error?: string;
        ocrText?: string;
        extraction?: Extraction;
        suggestedAmountBaseUnits?: number;
        suggestedUsdtUsd?: number;
        settlementFx?: SettlementFx | null;
        extractDebug?: ExtractDebugPayload;
      }>(r);
      if (!r.ok) throw new Error(j.error || r.statusText);
      setOcrText(j.ocrText || "");
      setExtraction(j.extraction ?? null);
      setSettlementFx(j.settlementFx ?? null);
      setSuggestedUsdtUsd(typeof j.suggestedUsdtUsd === "number" ? j.suggestedUsdtUsd : null);
      setExtractDebug(j.extractDebug ?? null);
      setSuggestedBase(j.suggestedAmountBaseUnits ?? null);
      setAmountBase(String(j.suggestedAmountBaseUnits ?? ""));
      const ext = j.extraction;
      setMemo(
        `${ext?.merchant ?? "payee"}|${ext?.category ?? "expense"}`.slice(0, 120)
      );
      setIndexNote(null);
      void fetch(apiUrl("/api/receipts/index"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: ext?.merchant ?? "",
          total: ext?.total ?? 0,
          category: ext?.category ?? "",
          ocrText: j.ocrText || "",
        }),
      })
        .then(async (ir) => {
          try {
            const body = await parseJsonOrThrow<{ error?: string }>(ir);
            if (!ir.ok) {
              setIndexNote(
                body.error ||
                  "Could not index this receipt for local search (first run may download an embedding model)."
              );
            }
          } catch (ie) {
            setIndexNote(ie instanceof Error ? ie.message : "Receipt search index response was not JSON.");
          }
        })
        .catch(() => {
          setIndexNote("Could not reach the API to index this receipt for search.");
        });
      window.setTimeout(() => {
        document.getElementById("review")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError(
          `Extraction timed out after ${EXTRACT_TIMEOUT_MS / 60_000} minutes. The API may still be downloading QVAC models — watch the terminal that runs the server, then try again.`
        );
      } else {
        setError(e instanceof Error ? e.message : "extract failed");
      }
    } finally {
      window.clearTimeout(timer);
      setLoading(false);
    }
  }, [file]);

  const extractPos = useCallback(async () => {
    if (!posFile) return;
    setPosLoading(true);
    setPosError(null);
    try {
      const fd = new FormData();
      fd.append("pos", posFile);
      const r = await fetch(apiUrl("/api/extract-pos"), { method: "POST", body: fd });
      const j = await parseJsonOrThrow<{
        error?: string;
        ocrText?: string;
        amount?: number;
        currency?: string;
        confidence?: number;
        extractDebug?: unknown;
      }>(r);
      if (!r.ok) throw new Error(j.error || r.statusText);
      setPosExtraction({
        ocrText: j.ocrText ?? "",
        amount: Number(j.amount ?? 0),
        currency: normalizeReceiptCurrency(j.currency ?? "USD"),
        confidence: Number(j.confidence ?? 0),
        extractDebug: j.extractDebug,
      });
    } catch (e) {
      setPosError(e instanceof Error ? e.message : "POS extraction failed");
    } finally {
      setPosLoading(false);
    }
  }, [posFile]);

  const applyPosToSettlement = useCallback(() => {
    if (!posExtraction) return;
    const currency = normalizeReceiptCurrency(posExtraction.currency || "USD");
    const amount = Number.isFinite(posExtraction.amount) ? posExtraction.amount : 0;
    const nextBase = Math.max(0, Math.round(amount * 1e6));
    setAmountBase(String(nextBase));
    setSuggestedBase(nextBase);
    setSuggestedUsdtUsd(currency === "USD" || currency === "USDT" ? nextBase / 1e6 : null);
    setSettlementFx(null);
    if (extraction) {
      setExtraction({
        ...extraction,
        total: amount,
        currency,
      });
    }
    if (!memo.trim()) {
      setMemo(`pos|${currency}`.slice(0, 120));
    }
  }, [posExtraction, extraction, memo]);

  useEffect(() => {
    if (!autoExtractAfterCamera || !file || loading) return;
    setAutoExtractAfterCamera(false);
    void extract();
  }, [autoExtractAfterCamera, file, loading, extract]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("textarea, input, select, [contenteditable=true]")) return;
      if (!file || loading) return;
      e.preventDefault();
      void extract();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, loading, extract]);

  const pay = async () => {
    setPayLoading(true);
    setError(null);
    setPayResult(null);
    setSigCopied(false);
    try {
      const r = await fetch(apiUrl("/api/pay"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: recipient.trim(),
          amountBaseUnits: Number(amountBase),
          memo: memo || undefined,
        }),
      });
      const j = await parseJsonOrThrow<{ error?: string; signature?: string }>(r);
      if (!r.ok) throw new Error(j.error || r.statusText);
      setPayResult(j.signature ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "pay failed");
    } finally {
      setPayLoading(false);
    }
  };

  const stopQrScanner = useCallback(async () => {
    const q = qrRunnerRef.current;
    qrRunnerRef.current = null;
    if (!q) return;
    try {
      await q.stop();
    } catch {
      /* not scanning */
    }
    try {
      await q.clear();
    } catch {
      /* ignore */
    }
    const live = document.getElementById("rtc-qr-reader");
    if (live) live.innerHTML = "";
  }, []);

  useEffect(() => {
    return () => {
      void stopQrScanner();
    };
  }, [stopQrScanner]);

  const openCameraScan = useCallback(async () => {
    setScanError(null);
    setScanOpen(true);
    setScanBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      await stopQrScanner();
      const qr = new Html5Qrcode("rtc-qr-reader");
      qrRunnerRef.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 260, height: 260 } },
        (decoded) => {
          const pk = parseRecipientFromScanOrPaste(decoded);
          if (pk) {
            setRecipient(pk);
            void stopQrScanner().then(() => {
              setScanOpen(false);
              setScanBusy(false);
            });
          }
        },
        () => {}
      );
      setScanBusy(false);
    } catch (e) {
      setScanBusy(false);
      setScanError(e instanceof Error ? e.message : "Camera QR failed");
    }
  }, [stopQrScanner]);

  const closeScanModal = useCallback(async () => {
    await stopQrScanner();
    setScanOpen(false);
    setScanBusy(false);
    setScanError(null);
  }, [stopQrScanner]);

  const onQrImagePicked = useCallback(
    async (list: FileList | null) => {
      const f = list?.[0];
      if (!f) return;
      setScanError(null);
      setScanBusy(true);
      try {
        const qr = new Html5Qrcode("rtc-qr-file-anchor", false);
        const decoded = await qr.scanFile(f, false);
        await qr.clear();
        const pk = parseRecipientFromScanOrPaste(decoded);
        if (!pk) {
          setScanError("No Solana address found in that QR image.");
        } else {
          setRecipient(pk);
        }
      } catch (e) {
        setScanError(e instanceof Error ? e.message : "QR image decode failed");
      } finally {
        setScanBusy(false);
      }
    },
    []
  );

  const useSignerAsRecipient = useCallback(() => {
    const a = health?.payerAddress?.trim();
    if (!a) return;
    setRecipient(a);
  }, [health?.payerAddress]);

  const runReceiptSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const r = await fetch(apiUrl("/api/receipts/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, limit: 10 }),
      });
      const j = await parseJsonOrThrow<{ error?: string; results?: ReceiptSearchHit[] }>(r);
      if (!r.ok) throw new Error(j.error || r.statusText);
      setSearchResults(j.results ?? []);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "search failed");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const extractionConfidence = extraction?.confidence;
  const extractionConfidenceLabel =
    extractionConfidence == null || !Number.isFinite(extractionConfidence)
      ? null
      : `${Math.round(Math.max(0, Math.min(1, extractionConfidence)) * 100)}%`;
  const lowConfidence = extractionConfidence != null && Number.isFinite(extractionConfidence) && extractionConfidence < 0.65;
  const receiptPosMismatch =
    extraction &&
    posExtraction &&
    Number.isFinite(extraction.total) &&
    Number.isFinite(posExtraction.amount) &&
    extraction.total > 0 &&
    posExtraction.amount > 0
      ? Math.abs(extraction.total - posExtraction.amount)
      : null;
  const hasMaterialPosMismatch =
    receiptPosMismatch != null &&
    receiptPosMismatch >= 1 &&
    extraction != null &&
    posExtraction != null &&
    receiptPosMismatch / Math.max(extraction.total, posExtraction.amount) >= 0.02;

  const copySignature = useCallback(async (sig: string) => {
    try {
      await navigator.clipboard.writeText(sig);
      setSigCopied(true);
      window.setTimeout(() => setSigCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const recipientLooksValid = useMemo(
    () => isValidSolanaRecipient(recipient.trim()),
    [recipient]
  );

  const canPay = useMemo(() => {
    return (
      confirmed &&
      recipientLooksValid &&
      Number.isFinite(Number(amountBase)) &&
      Number(amountBase) > 0
    );
  }, [confirmed, recipientLooksValid, amountBase]);

  const clusterKey = health?.solanaCluster ?? "devnet";
  const clusterLabel = health?.solanaClusterLabel ?? "Devnet";
  const payExplorerUrl =
    payResult && payResult.length > 0 ? explorerTxUrl(payResult, clusterKey) : null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      {import.meta.env.PROD && healthLoad === "error" && !getApiOrigin() && (
        <p className="rtc-api-origin-hint" role="status">
          The app cannot reach <code className="rtc-api-origin-hint__code">/api</code> (static host or
          tunnel down). <strong>Easiest on Vercel:</strong>{" "}
          <strong>Project → Settings → Environment Variables</strong> → add{" "}
          <code className="rtc-api-origin-hint__code">RTC_API_PROXY_TARGET</code> = your API origin
          (HTTPS, no trailing slash; e.g. ngrok), then <strong>Redeploy</strong> — same-origin{" "}
          <code className="rtc-api-origin-hint__code">/api/*</code> is proxied server-side (no client
          rebuild when the tunnel URL changes). Alternatives:{" "}
          <code className="rtc-api-origin-hint__code">VITE_API_BASE_URL</code> at build time, or open
          once with <code className="rtc-api-origin-hint__code">?rtc_api=https://your-tunnel</code>. For
          laptop-only use, run <code className="rtc-api-origin-hint__code">npm run dev</code>.
          {sanitizeHealthDetail(healthDetail) && (
            <span className="rtc-api-origin-hint__detail" role="log">
              {" "}
              ({sanitizeHealthDetail(healthDetail)})
            </span>
          )}
        </p>
      )}
      <header className="top-bar">
        <div className="top-bar__inner">
          <div className="brand">
            <div className="brand__mark brand__mark--tether" aria-hidden="true">
              <img
                className="brand__mark__img"
                src="/tether-brand.png"
                alt=""
                width={36}
                height={36}
                decoding="async"
              />
            </div>
            <div>
              <div className="brand__text">Receipt to Crypto</div>
              <div className="brand__tagline">Local QVAC · optional USDT with WDK on Solana</div>
            </div>
          </div>
          <div className="top-bar__meta" role="status" aria-live="polite">
            <span className="pill">QVAC + WDK</span>
            {healthLoad === "loading" && (
              <span className="pill pill--muted pill--shimmer">Connecting…</span>
            )}
            {healthLoad === "error" && <span className="pill pill--warn">API offline</span>}
            {healthLoad === "ok" && health && (
              <>
                <span className="pill pill--cluster">{clusterLabel}</span>
                <span className="pill pill--ok">Local QVAC</span>
                <span className={`pill${health.walletReady ? " pill--ok" : " pill--muted"}`}>
                  {health.walletReady ? "Wallet ready" : "Wallet off"}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="layout-body">
        <aside className="sidebar" aria-label="Workflow and stack">
          <h2 className="sidebar__title">Workflow</h2>
          <p className="sidebar__blurb">
            Receipt image → local extract → optional USDT after you verify fields.
          </p>
          <nav className="sidebar__nav" aria-label="Page sections">
            <a
              href="#workflow"
              onClick={(e) => {
                e.preventDefault();
                goToSection("workflow");
              }}
            >
              Upload &amp; extract
            </a>
            <a
              href="#review"
              onClick={(e) => {
                e.preventDefault();
                goToSection("review");
              }}
            >
              Review &amp; OCR
            </a>
            <a
              href="#fields"
              onClick={(e) => {
                e.preventDefault();
                goToSection(
                  "fields",
                  "Run extraction first to unlock field editing and settlement."
                );
              }}
            >
              Edit fields
            </a>
            <a
              href="#settlement"
              onClick={(e) => {
                e.preventDefault();
                goToSection(
                  "settlement",
                  "Run extraction first to unlock USDT settlement."
                );
              }}
            >
              Send USDT
            </a>
            <a
              href="#receipt-memory"
              onClick={(e) => {
                e.preventDefault();
                goToSection("receipt-memory");
              }}
            >
              Receipt search
            </a>
          </nav>
          <hr className="sidebar__rule" />
          <p className="sidebar__label">Stack</p>
          <ul className="sidebar__stack">
            <li>
              <strong>QVAC</strong> — local OCR + small LLM + embeddings search
            </li>
            <li>
              <strong>WDK</strong> — optional Solana USDT send
            </li>
            <li>
              <strong>USDT</strong> — verify amounts before signing
            </li>
          </ul>
        </aside>

        <main id="main-content" className="layout-main" tabIndex={-1}>
          <div className="main-inner">
            {navHint && (
              <div className="nav-hint" role="status">
                <span>{navHint}</span>
                <button type="button" className="nav-hint__dismiss" onClick={() => setNavHint(null)}>
                  Dismiss
                </button>
              </div>
            )}

            <ol className="stepper" aria-label="Workflow progress">
              <li
                className={`stepper__step${file ? " stepper__step--done" : " stepper__step--current"}`}
              >
                <span className="stepper__dot" aria-hidden="true" />
                Receipt
              </li>
              <li
                className={`stepper__step${
                  extraction ? " stepper__step--done" : file ? " stepper__step--current" : ""
                }`}
              >
                <span className="stepper__dot" aria-hidden="true" />
                Extract
              </li>
              <li
                className={`stepper__step${
                  payResult ? " stepper__step--done" : extraction ? " stepper__step--current" : ""
                }`}
              >
                <span className="stepper__dot" aria-hidden="true" />
                Settle
              </li>
            </ol>

        <section id="workflow" className="card card--hero" aria-labelledby="workflow-title">
          <div className="hero-intro">
            <div className="section-head">
              <div>
                <h1 id="workflow-title">Scan receipts, extract locally, pay USDT when you are ready</h1>
                <p className="sub sub--desktop-only">
                  <strong>QVAC</strong> runs OCR and a small LLM on <strong>your machine</strong> (via this
                  app’s API) — receipt bytes are not sent to a cloud LLM for extraction. After each
                  extraction we also embed the receipt text locally for <strong>semantic search</strong> over
                  past scans. Edit every field, then send <strong>USDT</strong> on Solana with{" "}
                  <strong>Tether WDK</strong> once you have the payee&apos;s Solana address (paste or scan their
                  wallet &quot;Receive&quot; QR).
                </p>
                <p className="sub sub--mobile-only">
                  <strong>Photo</strong> → local <strong>QVAC</strong> extract → verify fields → optional{" "}
                  <strong>USDT</strong> with WDK. Use <strong>Scan with smartphone</strong> for the best
                  camera flow.
                </p>
              </div>
            </div>
            <ComicHeroIllustration />
          </div>

          <div
            className={`drop${dragActive ? " drop--active" : ""}${isDesktopLayout ? " drop--clickable" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const f = e.dataTransfer.files[0];
              if (f) onFile(f);
            }}
            onClick={isDesktopLayout ? () => openReceiptPicker() : undefined}
            role={isDesktopLayout ? "button" : "region"}
            tabIndex={isDesktopLayout ? 0 : undefined}
            aria-label={
              isDesktopLayout
                ? "Drop receipt file or click to browse"
                : "Receipt preview — use Scan with smartphone or Browse files below"
            }
            onKeyDown={
              isDesktopLayout
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openReceiptPicker();
                    }
                  }
                : undefined
            }
          >
            <input
              id="file"
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
            <UploadIcon />
            {file ? (
              <>
                <div className="drop__title">Receipt selected</div>
                <div className="drop__file">{file.name}</div>
                <div className="drop__hint">Tap below to replace, or use camera / gallery</div>
              </>
            ) : (
              <>
                <div className="drop__title">Receipt photo</div>
                <div className="drop__hint drop__hint--mobile">
                  Use your phone camera for a paper receipt, or upload a JPEG / PNG / WebP.
                </div>
                <div className="drop__hint drop__hint--desktop">
                  Drop a file here or click to browse ·{" "}
                  <kbd className="kbd-hint">Ctrl</kbd> or <kbd className="kbd-hint">⌘</kbd> +{" "}
                  <kbd className="kbd-hint">Enter</kbd> runs extraction when a file is selected
                </div>
              </>
            )}
          </div>

          <div className="capture-actions">
            <button
              type="button"
              className="primary capture-actions__camera"
              onClick={(e) => {
                e.stopPropagation();
                setReceiptScannerOpen(true);
              }}
            >
              Scan with smartphone
            </button>
            <button
              type="button"
              className="secondary capture-actions__gallery"
              onClick={(e) => {
                e.stopPropagation();
                openReceiptPicker();
              }}
            >
              {isDesktopLayout ? "Browse files" : "Gallery / files"}
            </button>
          </div>
          <div className="pos-capture">
            <input
              id="pos-file"
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => onPosFile(e.target.files?.[0] ?? null)}
            />
            <div className="pos-capture__head">
              <strong>POS scanner</strong>
              <span>Capture the terminal screen amount and prefill USDT settlement.</span>
            </div>
            <div className="capture-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setPosScannerOpen(true)}
              >
                Scan POS screen
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => document.getElementById("pos-file")?.click()}
              >
                Upload POS image
              </button>
              <button
                type="button"
                className={posFile ? "primary" : "secondary"}
                disabled={!posFile || posLoading}
                onClick={extractPos}
              >
                {posLoading ? "Reading POS…" : "Extract POS"}
              </button>
            </div>
            {posFile && (
              <p className="pos-capture__meta">
                POS image: <strong>{posFile.name}</strong>
              </p>
            )}
            {posPreviewUrl && (
              <img className="pos-preview" src={posPreviewUrl} alt="POS screen preview" />
            )}
            {posError && <p className="err">{posError}</p>}
            {posExtraction && (
              <div className="pos-result">
                <p>
                  Parsed POS total: <strong>{posExtraction.amount.toFixed(2)} {posExtraction.currency}</strong>{" "}
                  · confidence {Math.round(Math.max(0, Math.min(1, posExtraction.confidence)) * 100)}%
                </p>
                <textarea readOnly value={posExtraction.ocrText} placeholder="POS OCR output" />
                <button type="button" className="primary" onClick={applyPosToSettlement}>
                  Apply POS total to settlement
                </button>
              </div>
            )}
          </div>
          <label className="check-row" style={{ margin: "0.6rem 0 0.15rem" }}>
            <input
              type="checkbox"
              checked={autoExtractOnUpload}
              onChange={(e) => setAutoExtractOnUpload(e.target.checked)}
            />
            <span>Auto-run extraction right after selecting or scanning a receipt.</span>
          </label>
          <p className="capture-note u-hide-narrow-mobile">
            <strong>Scan</strong> opens your camera with a live preview; one tap sends a full-resolution JPEG to
            your QVAC API and <strong>starts extraction</strong>. Receipt vs non-receipt is not judged in the
            browser — QVAC OCR+LLM runs on the server. Static hosts need a reachable <code className="footer-code">/api</code>{" "}
            (tunnel or deployed backend).
          </p>

          <div className="actions">
            <button
              className={file ? "primary" : "secondary"}
              type="button"
              disabled={!file || loading}
              onClick={extract}
            >
              {loading ? "Extracting…" : "Run extraction"}
            </button>
            <button
              className="secondary secondary--ghost"
              type="button"
              disabled={!file}
              onClick={clearReceipt}
            >
              Clear receipt
            </button>
          </div>
          {loading && (
            <div className="extract-wait-stack" role="status">
              <p className="extract-wait">
                Running local QVAC on your image. After models are cached on disk, this is usually a few
                seconds to about a minute — not “instant,” because OCR and a small LLM still run on your CPU
                / GPU.
              </p>
              {extractSlowHint && (
                <p className="extract-wait extract-wait--secondary">
                  Still working — the <strong>first</strong> extraction on a machine can download large
                  models (sometimes several minutes). Watch the API terminal for{" "}
                  <code className="extract-wait__code">[extract]</code> and{" "}
                  <code className="extract-wait__code">[QVAC …]</code> lines.
                </p>
              )}
            </div>
          )}
          {error && <div className="err">{error}</div>}
        </section>

        <section id="review" className="card" aria-labelledby="review-title">
          <h2 id="review-title" className="panel-title">
            Review
          </h2>
          {!file && (
            <p className="review-empty" role="status">
              No receipt selected yet. Upload a <strong>JPEG, PNG, or WebP</strong> image in{" "}
              <strong>Upload &amp; extract</strong> above, then click <strong>Run extraction</strong>. This
              panel shows the preview and raw OCR after you pick a file.
            </p>
          )}
          {file && previewUrl && (
            <div className="grid">
              <div className="field">
                <label>Receipt preview</label>
                <img
                  className="preview"
                  src={previewUrl}
                  alt="Uploaded receipt"
                  onLoad={() => setPreviewLoadError(null)}
                  onError={() =>
                    setPreviewLoadError(
                      "This image could not be shown in the browser. Try re-exporting as JPEG or PNG."
                    )
                  }
                />
                {previewLoadError && <p className="err review-preview-err">{previewLoadError}</p>}
              </div>
              <div className="field">
                <label>Raw OCR</label>
                <textarea readOnly value={ocrText} placeholder="Run extraction to populate…" />
              </div>
            </div>
          )}
        </section>

        {extraction && (
          <section id="fields" className="card" aria-labelledby="fields-title">
            <h2 id="fields-title" className="panel-title">
              Extracted fields
            </h2>
            <p style={{ margin: "-0.5rem 0 1rem", fontSize: "0.875rem", color: "var(--ink-muted)" }}>
              Edit anything before settlement — nothing sends until you sign below.
            </p>
            <div className="extraction-summary" aria-live="polite">
              <div className="extraction-summary__row">
                <span className="extraction-summary__label">Quick read</span>
                {extractionConfidenceLabel && (
                  <span className="extraction-summary__label">Model confidence {extractionConfidenceLabel}</span>
                )}
              </div>
              <p className="extraction-summary__merchant">{extraction.merchant || "—"}</p>
              <div className="extraction-summary__amounts">
                <span>
                  <span className="extraction-summary__label">Total</span>{" "}
                  <strong>
                    {Number.isFinite(extraction.total) ? extraction.total.toFixed(2) : "—"}{" "}
                    {normalizeReceiptCurrency(extraction.currency)}
                  </strong>
                </span>
                {(suggestedUsdtUsd != null || formatUsdFromMicroUsdt(suggestedBase)) && (
                  <span>
                    <span className="extraction-summary__label">USDT hint (USD notional)</span>{" "}
                    <strong>
                      {suggestedUsdtUsd != null
                        ? suggestedUsdtUsd.toLocaleString(undefined, {
                            style: "currency",
                            currency: "USD",
                            maximumFractionDigits: 2,
                          })
                        : formatUsdFromMicroUsdt(suggestedBase)}
                    </strong>
                  </span>
                )}
              </div>
              <p className="extraction-summary__hint">
                The USDT hint uses FX from the moment you ran <strong>Run extraction</strong>. If you change
                currency or total, tap extract again for an updated rate.
                {settlementFx?.source === "unmapped" && (
                  <>
                    {" "}
                    <span style={{ color: "var(--danger)" }}>
                      Rate for {settlementFx.from} was not available—hint assumes 1:1 vs USD; set{" "}
                      <code className="footer-code">{settlementFx.from}_USD_RATE</code> on the API if needed.
                    </span>
                  </>
                )}
              </p>
              {lowConfidence && (
                <p className="field-hint field-hint--warn" style={{ marginTop: "0.35rem" }}>
                  Low-confidence extraction. Verify and edit every field before any on-chain action.
                </p>
              )}
              {hasMaterialPosMismatch && (
                <p className="field-hint field-hint--warn" style={{ marginTop: "0.35rem" }}>
                  Receipt total and POS total differ ({extraction.total.toFixed(2)} vs{" "}
                  {posExtraction.amount.toFixed(2)}). Double-check before sending USDT.
                </p>
              )}
            </div>
            {extractDebug && (
              <details className="extract-debug" style={{ marginBottom: "1rem" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.875rem", fontWeight: 600 }}>
                  Extraction diagnostics (debug mode)
                </summary>
                <pre
                  style={{
                    margin: "0.5rem 0 0",
                    padding: "0.65rem 0.75rem",
                    fontSize: "0.75rem",
                    overflow: "auto",
                    background: "var(--surface-2)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--line)",
                  }}
                >
                  {JSON.stringify(extractDebug, null, 2)}
                </pre>
              </details>
            )}
            <div className="grid">
              <div className="field">
                <label>Merchant</label>
                <input
                  value={extraction.merchant}
                  onChange={(e) => {
                    const merchant = e.target.value;
                    setExtraction({ ...extraction, merchant });
                    setMemo(`${merchant}|${extraction.category}`.slice(0, 120));
                  }}
                  autoComplete="organization"
                />
              </div>
              <div className="field">
                <label>Currency (ISO 4217)</label>
                <input
                  value={extraction.currency}
                  onChange={(e) => {
                    const currency = normalizeReceiptCurrency(e.target.value).slice(0, 4);
                    const fxActive =
                      settlementFx && currency === settlementFx.from ? settlementFx : null;
                    if (settlementFx && !fxActive) setSettlementFx(null);
                    const total = extraction.total;
                    const b = usdtBaseUnitsFromTotal(total, currency, fxActive);
                    setExtraction({ ...extraction, currency });
                    setSuggestedBase(b);
                    setSuggestedUsdtUsd(
                      fxActive && normalizeReceiptCurrency(currency) === fxActive.from ? b / 1e6 : null
                    );
                    setAmountBase(String(b));
                  }}
                  spellCheck={false}
                  maxLength={4}
                  inputMode="text"
                  autoCapitalize="characters"
                  aria-label="Receipt currency code"
                />
              </div>
              <div className="field">
                <label>Total ({extraction.currency})</label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={extraction.total}
                  onChange={(e) => {
                    const total = Number(e.target.value);
                    setExtraction({ ...extraction, total });
                    const b = usdtBaseUnitsFromTotal(total, extraction.currency, settlementFx);
                    setSuggestedBase(b);
                    setSuggestedUsdtUsd(
                      settlementFx &&
                        normalizeReceiptCurrency(extraction.currency) === settlementFx.from
                        ? b / 1e6
                        : null
                    );
                    setAmountBase(String(b));
                  }}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={extraction.category}
                  onChange={(e) => {
                    const category = e.target.value;
                    setExtraction({ ...extraction, category });
                    setMemo(`${extraction.merchant}|${category}`.slice(0, 120));
                  }}
                />
              </div>
              <div className="field">
                <label>Date (YYYY-MM-DD)</label>
                <input
                  value={extraction.date ?? ""}
                  onChange={(e) => setExtraction({ ...extraction, date: e.target.value })}
                  placeholder="2026-04-28"
                  spellCheck={false}
                />
              </div>
              <div className="field field--grid-full">
                <label>Line items (optional, from OCR)</label>
                <textarea
                  readOnly
                  value={
                    extraction.lineItems && extraction.lineItems.length > 0
                      ? extraction.lineItems
                          .map((li) => {
                            const qty = li.quantity != null ? ` x${li.quantity}` : "";
                            const unit = li.unitPrice != null ? ` @ ${li.unitPrice}` : "";
                            const tot = li.total != null ? ` = ${li.total}` : "";
                            return `${li.description}${qty}${unit}${tot}`;
                          })
                          .join("\n")
                      : ""
                  }
                  placeholder="No line items extracted."
                />
              </div>
              <div className="field field--grid-full">
                <label>Suggested USDT (base units, 6 dp)</label>
                <input readOnly value={suggestedBase ?? ""} />
                {settlementFx && normalizeReceiptCurrency(extraction.currency) === settlementFx.from && (
                    <p
                      style={{
                        margin: "0.35rem 0 0",
                        fontSize: "0.8125rem",
                        color: "var(--ink-muted)",
                        lineHeight: 1.45,
                      }}
                    >
                      Uses indicative {settlementFx.from}/{settlementFx.to}{" "}
                      <strong>
                        {settlementFx.rate >= 1
                          ? settlementFx.rate.toFixed(4)
                          : settlementFx.rate.toFixed(6)}
                      </strong>{" "}
                      ({settlementFx.source}
                      {settlementFx.source === "frankfurter" && settlementFx.asOf
                        ? `, as of ${settlementFx.asOf}`
                        : ""}
                      ) so USDT tracks USD; not a live trading quote.
                    </p>
                  )}
              </div>
            </div>
          </section>
        )}

        {extraction && (
          <section id="settlement" className="card" aria-labelledby="settlement-title">
            <h2 id="settlement-title" className="panel-title">
              Settlement ({clusterLabel})
            </h2>
            <p className="settlement-lead">
              Paper receipts almost never include a Solana address. For a real <strong>USDT</strong> transfer,
              the payee must share a pubkey (e.g. Phantom <strong>Receive</strong> QR). Amount and memo here
              come from QVAC; you choose the destination.
            </p>
            <div className="settlement-actions" role="group" aria-label="Recipient helpers">
              <button type="button" className="secondary" disabled={scanBusy} onClick={() => void openCameraScan()}>
                Scan Receive QR (camera)
              </button>
              <label className={`btn-file${scanBusy ? " btn-file--disabled" : ""}`}>
                <span>Scan QR from image</span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={scanBusy}
                  onChange={(e) => void onQrImagePicked(e.target.files)}
                />
              </label>
              {health?.payerAddress && (
                <button type="button" className="secondary" onClick={useSignerAsRecipient}>
                  Use signer wallet (test / self-send)
                </button>
              )}
            </div>
            {scanError && <p className="err settlement-inline-err">{scanError}</p>}
            <div className="grid">
              <div className="field">
                <label>Recipient address (Solana)</label>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Base58 address or paste solana:… link"
                  spellCheck={false}
                  aria-invalid={recipient.trim().length > 0 && !recipientLooksValid}
                />
                {recipient.trim().length > 0 && !recipientLooksValid && (
                  <p className="field-hint field-hint--warn">Not a valid Solana public key.</p>
                )}
              </div>
              <div className="field">
                <label>Amount (base units)</label>
                <input
                  value={amountBase}
                  onChange={(e) => setAmountBase(e.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Memo (optional)</label>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I have checked the <strong>recipient</strong> and <strong>amount</strong> and I am ready to
                sign this transaction.
              </span>
            </label>
            <div className="actions">
              <button className="primary" type="button" disabled={!canPay || payLoading} onClick={pay}>
                {payLoading ? "Signing…" : "Send USDT"}
              </button>
            </div>
            {payResult && (
              <div className="ok ok--tx">
                <div className="ok__row">
                  <span className="ok__label">Signature</span>
                  <code className="ok__sig">{payResult}</code>
                </div>
                <div className="ok__actions">
                  <button type="button" className="ok__copy" onClick={() => void copySignature(payResult)}>
                    {sigCopied ? "Copied" : "Copy signature"}
                  </button>
                  {payExplorerUrl && (
                    <a
                      className="ok__link"
                      href={payExplorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Solana Explorer
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        <section id="receipt-memory" className="card" aria-labelledby="memory-title">
          <h2 id="memory-title" className="panel-title">
            Receipt search (QVAC embeddings)
          </h2>
          <p className="settlement-lead">
            Each successful extraction is embedded on-device and stored under{" "}
            <code className="footer-code">.rtc-data/</code> on the machine running the API. Ask natural-language
            questions over merchants, totals, or items you have scanned before.
          </p>
          {indexNote && <p className="err settlement-inline-err">{indexNote}</p>}
          <div className="memory-search-row">
            <input
              className="memory-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runReceiptSearch();
                }
              }}
              placeholder='e.g. "coffee shop over 40 dollars"'
              aria-label="Search past receipts"
            />
            <button type="button" className="secondary" disabled={searchLoading} onClick={() => void runReceiptSearch()}>
              {searchLoading ? "Searching…" : "Search"}
            </button>
          </div>
          {searchError && <p className="err">{searchError}</p>}
          {searchResults.length > 0 && (
            <ul className="memory-results">
              {searchResults.map((h) => (
                <li key={h.id} className="memory-hit">
                  <div className="memory-hit__meta">
                    <strong>{h.merchant}</strong>
                    <span className="memory-hit__score">score {(h.score * 100).toFixed(1)}%</span>
                  </div>
                  <div className="memory-hit__sub">
                    {h.category} · total {h.total} · {new Date(h.at).toLocaleString()}
                  </div>
                  <p className="memory-hit__preview">{h.preview}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

          </div>
        </main>
      </div>

      <div id="rtc-qr-file-anchor" className="qr-anchor" aria-hidden="true" />

      <ReceiptCameraScanner
        open={receiptScannerOpen}
        title="Scan receipt"
        onClose={() => setReceiptScannerOpen(false)}
        onCapture={(f) => {
          onFile(f, { fromCamera: true });
          setReceiptScannerOpen(false);
        }}
      />
      <ReceiptCameraScanner
        open={posScannerOpen}
        title="Scan POS receipt"
        onClose={() => setPosScannerOpen(false)}
        onCapture={(f) => {
          onPosFile(f);
          setPosScannerOpen(false);
        }}
      />

      {scanOpen && (
        <div className="scan-overlay" role="dialog" aria-modal="true" aria-label="Scan merchant QR">
          <div className="scan-modal">
            <div className="scan-modal__head">
              <h3>Scan merchant Receive QR</h3>
              <button type="button" className="scan-modal__close" onClick={() => void closeScanModal()}>
                Close
              </button>
            </div>
            <p className="scan-modal__hint">Point the camera at their wallet&apos;s Receive QR (Phantom, Backpack, …).</p>
            <div id="rtc-qr-reader" className="qr-reader" />
            {scanBusy && <p className="scan-modal__status">Starting camera…</p>}
            {scanError && <p className="err">{scanError}</p>}
          </div>
        </div>
      )}

      <footer className="site-footer">
        <div className="site-footer__inner">
          <div className="site-footer__top">
            <div className="site-footer__intro">
              <div className="site-footer__brand">Receipt to Crypto</div>
              <p className="site-footer__tag">
                Local receipt extraction with QVAC and optional USDT settlement with Tether WDK — open
                source, run the full flow with <code className="footer-code">npm run dev</code>.
              </p>
            </div>
            <nav className="site-footer__links" aria-label="External resources">
              <a
                href="https://github.com/panagot/Tether-Receipt-to-Crypto"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
              <a href="https://tether.to" target="_blank" rel="noopener noreferrer">
                Tether
              </a>
              <a href="https://solana.com" target="_blank" rel="noopener noreferrer">
                Solana
              </a>
            </nav>
          </div>
          <div className="site-footer__legal">
            <p>
              QVAC runs OCR and extraction locally on your machine. Never commit real seeds, mnemonics, or
              mainnet keys to source control.
            </p>
            <p className="site-footer__copy">© {new Date().getFullYear()} Receipt to Crypto · Frontier demo</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
