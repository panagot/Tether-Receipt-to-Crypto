import { useCallback, useEffect, useMemo, useState } from "react";
import { ComicHeroIllustration } from "./ComicHeroIllustration";
import { explorerTxUrl } from "./explorerTx";

const SETTLEMENT_LS = "rtc:settlement-v1";

type ApiHealth = {
  ok?: boolean;
  mockAi?: boolean;
  solanaCluster?: string;
  solanaClusterLabel?: string;
  walletReady?: boolean;
  node?: string;
};

type Extraction = {
  merchant: string;
  total: number;
  currency: string;
  category: string;
  confidence?: number;
  notes?: string;
};

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
  const [navHint, setNavHint] = useState<string | null>(null);
  const [sigCopied, setSigCopied] = useState(false);

  useEffect(() => {
    setHealthLoad("loading");
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: ApiHealth) => {
        setHealth(j);
        setHealthLoad("ok");
      })
      .catch(() => {
        setHealth(null);
        setHealthLoad("error");
      });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTLEMENT_LS, JSON.stringify({ recipient, memo, amountBase }));
    } catch {
      /* ignore quota */
    }
  }, [recipient, memo, amountBase]);

  const onFile = useCallback((f: File | null) => {
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return f ? URL.createObjectURL(f) : null;
    });
    setFile(f);
    setExtraction(null);
    setOcrText("");
    setSuggestedBase(null);
    setPayResult(null);
    setError(null);
  }, []);

  const clearReceipt = useCallback(() => {
    onFile(null);
    setConfirmed(false);
  }, [onFile]);

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
    try {
      const fd = new FormData();
      fd.append("receipt", file);
      const r = await fetch("/api/extract", { method: "POST", body: fd });
      const j = (await r.json()) as {
        error?: string;
        ocrText?: string;
        extraction?: Extraction;
        suggestedAmountBaseUnits?: number;
      };
      if (!r.ok) throw new Error(j.error || r.statusText);
      setOcrText(j.ocrText || "");
      setExtraction(j.extraction ?? null);
      setSuggestedBase(j.suggestedAmountBaseUnits ?? null);
      setAmountBase(String(j.suggestedAmountBaseUnits ?? ""));
      const ext = j.extraction;
      setMemo(
        `${ext?.merchant ?? "payee"}|${ext?.category ?? "expense"}`.slice(0, 120)
      );
      window.setTimeout(() => {
        document.getElementById("review")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    } catch (e) {
      setError(e instanceof Error ? e.message : "extract failed");
    } finally {
      setLoading(false);
    }
  }, [file]);

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
      const r = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: recipient.trim(),
          amountBaseUnits: Number(amountBase),
          memo: memo || undefined,
        }),
      });
      const j = (await r.json()) as { error?: string; signature?: string };
      if (!r.ok) throw new Error(j.error || r.statusText);
      setPayResult(j.signature ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "pay failed");
    } finally {
      setPayLoading(false);
    }
  };

  const copySignature = useCallback(async (sig: string) => {
    try {
      await navigator.clipboard.writeText(sig);
      setSigCopied(true);
      window.setTimeout(() => setSigCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const canPay = useMemo(() => {
    return (
      confirmed &&
      recipient.trim().length >= 32 &&
      Number.isFinite(Number(amountBase)) &&
      Number(amountBase) > 0
    );
  }, [confirmed, recipient, amountBase]);

  const clusterKey = health?.solanaCluster ?? "devnet";
  const clusterLabel = health?.solanaClusterLabel ?? "Devnet";
  const payExplorerUrl =
    payResult && payResult.length > 0 ? explorerTxUrl(payResult, clusterKey) : null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
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
                {health.mockAi ? (
                  <span className="pill pill--warn">Mock AI</span>
                ) : (
                  <span className="pill pill--ok">Local AI</span>
                )}
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
                goToSection(
                  "review",
                  "Add a receipt and run extraction to open Review & OCR."
                );
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
          </nav>
          <hr className="sidebar__rule" />
          <p className="sidebar__label">Stack</p>
          <ul className="sidebar__stack">
            <li>
              <strong>QVAC</strong> — local OCR + small LLM
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
                <p className="sub">
                  <strong>QVAC</strong> runs OCR and a small LLM on <strong>your machine</strong> (via this
                  app’s API) — receipt bytes are not sent to a cloud LLM for extraction. Edit every field,
                  then optionally send <strong>USDT</strong> on Solana with <strong>Tether WDK</strong> after
                  you confirm recipient and amount.
                </p>
              </div>
            </div>
            <ComicHeroIllustration />
          </div>

          <div
            className={`drop${dragActive ? " drop--active" : ""}`}
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
            onClick={() => document.getElementById("file")?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload receipt image"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                document.getElementById("file")?.click();
              }
            }}
          >
            <input
              id="file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
            <UploadIcon />
            {file ? (
              <>
                <div className="drop__title">Receipt selected</div>
                <div className="drop__file">{file.name}</div>
                <div className="drop__hint">Click to replace · JPEG, PNG, or WebP</div>
              </>
            ) : (
              <>
                <div className="drop__title">Drop receipt here or browse</div>
                <div className="drop__hint">
                  Camera photos and scans work best with good lighting ·{" "}
                  <kbd className="kbd-hint">Ctrl</kbd> or <kbd className="kbd-hint">⌘</kbd> +{" "}
                  <kbd className="kbd-hint">Enter</kbd> runs extraction when a file is selected
                </div>
              </>
            )}
          </div>

          <div className="actions">
            <button className="secondary" type="button" disabled={!file || loading} onClick={extract}>
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
          {error && <div className="err">{error}</div>}
        </section>

        {previewUrl && (
          <section id="review" className="card" aria-labelledby="review-title">
            <h2 id="review-title" className="panel-title">
              Review
            </h2>
            <div className="grid">
              <div className="field">
                <label>Receipt preview</label>
                <img className="preview" src={previewUrl} alt="Uploaded receipt" />
              </div>
              <div className="field">
                <label>Raw OCR</label>
                <textarea readOnly value={ocrText} placeholder="Run extraction to populate…" />
              </div>
            </div>
          </section>
        )}

        {extraction && (
          <section id="fields" className="card" aria-labelledby="fields-title">
            <h2 id="fields-title" className="panel-title">
              Extracted fields
            </h2>
            <p style={{ margin: "-0.5rem 0 1rem", fontSize: "0.875rem", color: "var(--ink-muted)" }}>
              Edit anything before settlement — nothing sends until you sign below.
            </p>
            <div className="grid">
              <div className="field">
                <label>Merchant</label>
                <input
                  value={extraction.merchant}
                  onChange={(e) => setExtraction({ ...extraction, merchant: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Total ({extraction.currency})</label>
                <input
                  type="number"
                  step="0.01"
                  value={extraction.total}
                  onChange={(e) => {
                    const total = Number(e.target.value);
                    setExtraction({ ...extraction, total });
                    setAmountBase(String(Math.round(total * 1e6)));
                  }}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={extraction.category}
                  onChange={(e) => setExtraction({ ...extraction, category: e.target.value })}
                />
              </div>
              <div className="field">
                <label>USDT amount (base units, 6 dp)</label>
                <input readOnly value={suggestedBase ?? ""} />
              </div>
            </div>
          </section>
        )}

        {extraction && (
          <section id="settlement" className="card" aria-labelledby="settlement-title">
            <h2 id="settlement-title" className="panel-title">
              Settlement ({clusterLabel})
            </h2>
            <div className="grid">
              <div className="field">
                <label>Recipient address</label>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Solana address"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label>Amount (base units)</label>
                <input value={amountBase} onChange={(e) => setAmountBase(e.target.value)} />
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

          </div>
        </main>
      </div>

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
              Models run locally via QVAC when mock mode is off. Never commit real seeds, mnemonics, or
              mainnet keys to source control.
            </p>
            <p className="site-footer__copy">© {new Date().getFullYear()} Receipt to Crypto · Frontier demo</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
