# Receipt to Crypto

**QVAC** (local OCR + small LLM) turns a receipt image into editable fields (merchant, total, category). **Tether WDK** optionally sends **USDT** on Solana after you confirm the recipient and amount.

## For judges (demo checklist)

1. **Environment** — Node **≥ 22.17**, pills in the header: cluster (e.g. Devnet), Local QVAC, wallet ready/off. Extraction runs QVAC on your receipt image (GPU/Vulkan on Windows when available).
2. **Upload** — Drop or select a JPEG/PNG/WebP receipt → **Run extraction** (or **Ctrl+Enter** / **⌘+Enter** with a file selected).
3. **Review** — Preview + raw OCR; totals are inferred locally — verify before paying.
4. **Fields** — Edit any value; USDT base units follow the fiat total when you change it.
5. **Settlement** — Receipts do not contain a Solana address. Use **Scan Receive QR** (camera or image) or paste a base58 / `solana:…` link. Optional **Use signer wallet** for a devnet self-send smoke test. Confirm checkbox → **Send USDT** → Explorer link.
6. **Receipt search** — After each extract, the API indexes the receipt text with **QVAC embeddings** (first search may download a small embedding model). Use **Receipt search** for natural-language lookup over past scans (data in `.rtc-data/` on the API host).

**Architecture:** Vite UI + Express API on your machine. Receipt bytes hit the **local** API; QVAC runs **OCR**, **LLM JSON extraction**, and optional **embedding** for search — no cloud inference for those steps. Configure `WALLET_SEED` + `USDT_MINT` for `/api/pay`. On **Vercel**, the repo includes **serverless `/api/*` proxies** (see `api/`) that forward to **`RTC_API_PROXY_TARGET`** so the browser can keep same-origin `/api` without rebaking `VITE_API_BASE_URL` when your tunnel URL changes. For very long extractions, prefer **`VITE_API_BASE_URL`** (browser → tunnel directly) or a paid Vercel function duration tier, because the proxy is capped by Vercel’s function timeout (e.g. 60s on Hobby).

## Requirements

- Node.js **≥ 22.17**
- Windows: Vulkan-capable GPU for QVAC (first run may download models)

## Setup

```bash
cp .env.example .env
# Edit .env: WALLET_SEED, USDT_MINT for devnet pay tests
npm install
npm run dev
```

- UI: http://127.0.0.1:5173  
- API: http://127.0.0.1:3847/api/health  

## Scripts

- `npm run dev` — API + Vite together  
- `npm run dev:server` / `npm run dev:client` — separately  
- `npm run build` — typecheck server + build client  
- `npm start` — production API (serve `client/dist` if `NODE_ENV=production` and built)
- `npm run verify:backend` — `GET /api/health` only (fast). Default base `http://127.0.0.1:3847` or `RTC_API_BASE` / first CLI arg if it is an `http(s)://` URL.
- `npm run verify:backend -- https://tunnel.example` — health against a tunnel.
- `npm run verify:backend -- test/fixtures/tiny-receipt.jpg` — health + `POST /api/extract` on the bundled tiny JPEG (can take minutes while QVAC loads models; override timeout with `RTC_EXTRACT_TIMEOUT_MS`).
- `npm run verify:backend:extract` — same as the single-arg fixture command above.
- `npm run test:unit` — no server: `apiBase` / `apiJson` contract tests + receipt fixture magic-bytes check.
- `npm run test:all` — `build` + `test:unit` + `verify:backend` (start the API first, or health step fails).
- `npm run gen:fixture:tiny-receipt` — regenerate `test/fixtures/tiny-receipt.jpg` if needed.

Run `verify:backend` (and optionally `verify:backend:extract`) before testing **Scan with smartphone** against a tunnel.

**Vercel env copy-paste:** with `ngrok http 3847` running, run **`npm run vercel:env-snippet`** — it prints the exact **Key** and **Value** for `RTC_API_PROXY_TARGET` from ngrok’s local API. You still paste that into the Vercel dashboard (no CLI access from here).

## API (local)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Cluster, wallet readiness, **`payerAddress`** (signer pubkey when configured) |
| POST | `/api/extract` | multipart `receipt` → QVAC OCR + LLM |
| POST | `/api/pay` | JSON `{ recipient, amountBaseUnits, memo? }` → WDK USDT transfer |
| POST | `/api/receipts/index` | JSON `{ merchant, total, category, ocrText }` → QVAC embed + save under `.rtc-data/` |
| POST | `/api/receipts/search` | JSON `{ query, limit? }` → cosine-ranked receipt hits |

**Embedding model issues:** Receipt search skips non-`.gguf` registry entries (e.g. stray `*.tensors.txt`) and tries several GGUFs in order. Override with `RTC_EMBEDDING_REGISTRY_PATH` set to a **registry path string** that matches `ModelRegistryEntry.registryPath` (see QVAC registry). If a download is corrupt, delete the broken folder under `~/.qvac/models/` and retry.

## Vercel

Import this repo in [Vercel](https://vercel.com): build runs `npm run build`, static UI is `client/dist`, and **serverless routes** live under `api/` (see [`vercel.json`](vercel.json)).

### Recommended: `RTC_API_PROXY_TARGET` (server env, survives tunnel URL changes)

1. Run the real API somewhere with **HTTPS** (e.g. **ngrok** / **Cloudflare Tunnel** to the machine running `npm run dev` or `npm start`).
2. In Vercel **Project → Settings → Environment Variables**, add **`RTC_API_PROXY_TARGET`** = that origin only (e.g. `https://xxxx.ngrok-free.app`, **no** trailing slash, **do not** append `/api`).
3. **Redeploy.** The browser keeps calling same-origin **`/api/*`**; Vercel functions forward to your backend (allowlisted paths only). Update **`RTC_API_PROXY_TARGET`** when the tunnel URL changes — **no client rebuild**.

**Limits:** Vercel **function wall-clock** (e.g. **60s** on this repo’s proxy) may cut off a slow first **QVAC** extract. If that happens, use **`VITE_API_BASE_URL`** at build time so the browser talks to the tunnel directly, or raise limits on a paid plan.

### Alternatives

- **`VITE_API_BASE_URL`** — bake the API origin into the static bundle at build time; change tunnel URL → rebuild + redeploy.
- **`?rtc_api=https://…`** — one-time per-browser session override (no Vercel env); see banner copy on the live site when health fails.

From your PC: `npm run verify:backend -- https://xxxx.ngrok-free.app` before scanning on a phone.

The red **deployment** banner on [tether-receipt-to-crypto.vercel.app](https://tether-receipt-to-crypto.vercel.app/) appears only when **`/api/health`** fails in production **and** the client has no `VITE_` / `?rtc_api=` override — after **`RTC_API_PROXY_TARGET`** is set and the tunnel is up, health should succeed and the banner stays hidden.

On **phones**, the hosted UI offers **Take photo with camera** (`capture="environment"`) and **Choose from gallery**; after a camera shot it **auto-starts extraction** when **`/api`** is reachable (Vercel proxy to **`RTC_API_PROXY_TARGET`**, or **`VITE_API_BASE_URL`**, or **`?rtc_api=`**).

## Links

- **Source:** [github.com/panagot/Tether-Receipt-to-Crypto](https://github.com/panagot/Tether-Receipt-to-Crypto)
