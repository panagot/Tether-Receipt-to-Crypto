# Receipt to Crypto

**QVAC** (local OCR + small LLM) turns a receipt image into editable fields (merchant, total, category). **Tether WDK** optionally sends **USDT** on Solana after you confirm the recipient and amount.

## For judges (demo checklist)

1. **Environment** — Node **≥ 22.17**, pills in the header: cluster (e.g. Devnet), Local QVAC, wallet ready/off. Extraction runs QVAC on your receipt image (GPU/Vulkan on Windows when available).
2. **Upload** — Drop or select a JPEG/PNG/WebP receipt → **Run extraction** (or **Ctrl+Enter** / **⌘+Enter** with a file selected).
3. **Review** — Preview + raw OCR; totals are inferred locally — verify before paying.
4. **Fields** — Edit any value; USDT base units follow the fiat total when you change it.
5. **Settlement** — Receipts do not contain a Solana address. Use **Scan Receive QR** (camera or image) or paste a base58 / `solana:…` link. Optional **Use signer wallet** for a devnet self-send smoke test. Confirm checkbox → **Send USDT** → Explorer link.
6. **Receipt search** — After each extract, the API indexes the receipt text with **QVAC embeddings** (first search may download a small embedding model). Use **Receipt search** for natural-language lookup over past scans (data in `.rtc-data/` on the API host).

**Architecture:** Vite UI + Express API on your machine. Receipt bytes hit the **local** API; QVAC runs **OCR**, **LLM JSON extraction**, and optional **embedding** for search — no cloud inference for those steps. Configure `WALLET_SEED` + `USDT_MINT` for `/api/pay`. Static-only hosts do not serve `/api`; use `npm run dev` or `npm start` for the full loop.

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

## API (local)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Cluster, wallet readiness, **`payerAddress`** (signer pubkey when configured) |
| POST | `/api/extract` | multipart `receipt` → QVAC OCR + LLM |
| POST | `/api/pay` | JSON `{ recipient, amountBaseUnits, memo? }` → WDK USDT transfer |
| POST | `/api/receipts/index` | JSON `{ merchant, total, category, ocrText }` → QVAC embed + save under `.rtc-data/` |
| POST | `/api/receipts/search` | JSON `{ query, limit? }` → cosine-ranked receipt hits |

## Vercel

Import this repo in [Vercel](https://vercel.com): build runs `npm run build` and static output is `client/dist` (see `vercel.json`). The UI calls `/api/*`; on a static deployment those routes are not served unless you add a separate backend or serverless routes, so point the production UI at your API host or use Vercel only for the frontend demo.

## Links

- **Source:** [github.com/panagot/Tether-Receipt-to-Crypto](https://github.com/panagot/Tether-Receipt-to-Crypto)
