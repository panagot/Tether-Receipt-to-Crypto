# Tether | Receipt to Crypto

> **Scan any receipt or POS screen → extract the total locally with QVAC → settle in USDT on Solana.**

A QVAC-first app that turns multilingual receipts and POS screens into **settlement-ready USDT amounts**. OCR, structured extraction, and embeddings run **on-device via QVAC**; on-chain settlement is optional and uses **Tether WDK** on Solana.

- **Live demo:** https://tether-receipt-to-crypto.vercel.app/
- **Source:** https://github.com/panagot/Tether-Receipt-to-Crypto
- **Walkthrough video (Loom):** https://www.loom.com/share/aceffa7ceb064a2ba63f56959c2e213c

---

## What it does (60-second tour)

1. **Scan** a receipt with your phone camera or upload an image (any language).
2. **Extract locally with QVAC** — receipt OCR + structured JSON (`merchant`, `total`, `currency`, `category`, `confidence`).
3. **Review** fields. Edit anything before doing anything on-chain.
4. **FX → USDT hint** — we convert the receipt total into a transparent USD/USDT amount with the FX **source labelled** (`env` / `frankfurter` / `fallback` / `unmapped`).
5. **Optional settlement** — if you provide a Solana recipient + a configured wallet, send **USDT** with **Tether WDK**.
6. **Receipt memory** — every successful extraction is locally embedded with QVAC for **semantic search** over your scans.

> The extraction step never sends your receipt image to a cloud LLM. QVAC runs the OCR + LLM JSON extraction + embedding **on the host machine running the API**.

---

## Why this matters (judge view)

- **Real cross-border pain** — freelancers, remote teams, DAO ops, and small merchants already deal with multilingual receipts and stablecoin settlement. They retype totals, guess FX, and make mistakes.
- **QVAC, not a wrapper** — OCR, structured extraction, and embeddings are all genuine local QVAC capabilities used in the actual user flow.
- **Honest UX** — confidence score, FX source label, and an explicit human-in-the-loop review step. No surprise on-chain action.
- **Tether-native output** — totals are translated into a USDT amount + base units, ready for a real Solana transfer with Tether WDK.

---

## Submission summary

| | |
|---|---|
| Project Title | Tether \| Receipt to Crypto |
| One-liner | *Scan receipts, extract locally with QVAC, settle in USDT on Solana when you’re ready.* |
| Track | Tether **Frontier sidetrack** |
| QVAC capabilities used | **OCR**, **LLM extraction**, **embeddings** (local search) |
| Tether stack used | **USDT** on Solana via **Tether WDK** |

---

## Architecture (at a glance)

- **Frontend:** Vite + React (TypeScript). Camera capture, auto-scan progress, review UI, settlement form, embeddings search.
- **Backend (local):** Node + Express + TypeScript. Calls QVAC for OCR / LLM JSON / embeddings. Optional WDK-based USDT transfer.
- **Hosting:** UI on Vercel; QVAC runs on the host where the API is started (your laptop or a server). Vercel `api/*` is a thin proxy to a single env var (`RTC_API_PROXY_TARGET`) so the tunnel URL can change without rebuilds.

```
Browser ──▶ /api/* (Vercel proxy) ──▶ HTTPS tunnel ──▶ Node API ──▶ QVAC (OCR / LLM / embed)
                                                              │
                                                              └──▶ Tether WDK (Solana, on user confirm)
```

---

## QVAC integration depth

- **OCR** — `@qvac/sdk` model registry → ONNX OCR for multilingual receipt reading. Adaptive language list and a fallback OCR pass with image enhancement when signal is low.
- **LLM extraction** — small local LLM (Llama-3.2-1B class) prompted to return strict JSON: `merchant`, `total`, `currency`, `category`, `confidence`, optional `notes`/`date`/`lineItems`. Output goes through schema validation (`zod`) and a deterministic reconciliation layer that fixes common OCR/LLM artefacts (Greek/EU comma decimals, footer/auth-code contamination, currency symbol confusion, leading-`8` from `$` misreads, etc.).
- **Embeddings** — successful extractions are embedded locally and stored in `.rtc-data/`. The Receipt Search panel runs cosine search on those embeddings — entirely on your machine.
- **Reliability features** — registry-lock retry, OCR signal scoring, multi-pass OCR, sanitized language list, schema-safe normalization, structured timing/lang/confidence diagnostics under `RTC_EXTRACT_DEBUG=1`.

No cloud LLM is ever called for extraction.

---

## USDT / Tether integration

- Once a receipt is parsed, the API returns:
  - `extraction` (validated structured fields),
  - `suggestedAmountBaseUnits` (USDT base units, 6 decimals),
  - `suggestedUsdtUsd` (USD notional),
  - `settlementFx` (with `source` label).
- `/api/pay` uses **Tether WDK** to sign a USDT SPL transfer on Solana. The user must explicitly check a confirmation box and click **Send USDT**.
- Devnet is the default; configure `WALLET_SEED` + `USDT_MINT` to enable signing.

---

## Run it locally (Windows / macOS / Linux)

Requirements: **Node ≥ 22.17**. On Windows, a Vulkan-capable GPU helps QVAC.

```bash
git clone https://github.com/panagot/Tether-Receipt-to-Crypto
cd Tether-Receipt-to-Crypto/receipt-to-crypto

cp .env.example .env
npm install
npm run dev
```

Then open:

- UI: http://localhost:5173 (or 5174 if 5173 is busy)
- API health: http://127.0.0.1:3847/api/health

First extraction can take a while because QVAC may download models — that’s a one-time cost.

---

## Useful scripts

| Script | What it does |
|---|---|
| `npm run dev` | API + Vite together (recommended) |
| `npm run dev:server` / `npm run dev:client` | Start API or UI separately |
| `npm run build` | Type-check server + production build the client |
| `npm start` | Production API; serves `client/dist` if built |
| `npm run verify:backend` | Hit `/api/health` against a local or tunnel URL |
| `npm run verify:backend:extract` | Health + extract on the bundled tiny fixture |
| `npm run test:unit` | Fast unit checks (no server) |
| `npm run test:reconcile` | Receipt reconciliation regressions (Greek/EU/MYR/etc.) |
| `npm run test:all` | `build` + `test:unit` + `verify:backend` |
| `npm run vercel:env-snippet` | Print/refresh `RTC_API_PROXY_TARGET` value via Cloudflare quick tunnel |

---

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Cluster, wallet readiness, signer pubkey |
| POST | `/api/extract` | multipart `receipt` → QVAC OCR + LLM + reconciled JSON |
| POST | `/api/extract-pos` | multipart `pos` → POS screen amount/currency extraction |
| POST | `/api/pay` | JSON `{ recipient, amountBaseUnits, memo? }` → WDK USDT transfer |
| POST | `/api/receipts/index` | JSON `{ merchant, total, category, ocrText }` → embed + save |
| POST | `/api/receipts/search` | JSON `{ query, limit? }` → ranked receipt hits |

`extraction` shape returned by `/api/extract`:

- `merchant`: string
- `total`: number
- `currency`: ISO 4217 code (auto-normalized; `EURO` → `EUR`, etc.)
- `date` (optional): `YYYY-MM-DD`
- `lineItems` (optional)
- `category`: `food | transport | retail | services | utilities | healthcare | other`
- `confidence`: 0..1
- `notes` (optional)

---

## Hosting on Vercel

The repo ships a thin Vercel proxy under `api/`. The browser keeps calling **same-origin** `/api/*`, and Vercel forwards allowlisted routes to a single env var:

1. Run the API anywhere reachable over **HTTPS** (Cloudflare quick tunnel, ngrok, or a real host).
2. In **Project → Settings → Environment Variables**, add:

   ```
   RTC_API_PROXY_TARGET=https://your-api-origin.example
   ```

   Origin only. **No** trailing slash. **Do not** append `/api`.
3. **Redeploy.**

When the tunnel URL changes, just update that env var — no client rebuild required.

If `/api/health` is unreachable, the deployed UI shows a clear hint with the exact env name to set. You can also bypass it for one browser session with `?rtc_api=https://your-api-origin`.

---

## Demo script (≤ 2 minutes)

1. Show the live site → open the **How it works** popup (footer button) for the 6-step infographic.
2. Tap **Scan with smartphone**, capture a real receipt (multilingual is best).
3. Watch the live scan progress reach 100% and auto-extract.
4. Show structured fields + USDT hint with FX source label.
5. Optionally edit a field to show the hint update.
6. (Optional) Show the **Receipt search** panel querying past scans.
7. (Optional) Show settlement form prefilled and explain the explicit confirm gate before signing.

---

## Security & honesty

- Receipt images are **not** sent to a cloud LLM for extraction.
- Confidence and FX source are surfaced in the UI; no on-chain action happens without an explicit user confirmation.
- The repo is a hackathon demo — never commit real seeds, mnemonics, or mainnet keys.

---

## Links

- Live demo: https://tether-receipt-to-crypto.vercel.app/
- Source: https://github.com/panagot/Tether-Receipt-to-Crypto
- Loom walkthrough: https://www.loom.com/share/aceffa7ceb064a2ba63f56959c2e213c
- Colosseum project: https://arena.colosseum.org/projects/explore/tether-or-receipt-to-crypto
