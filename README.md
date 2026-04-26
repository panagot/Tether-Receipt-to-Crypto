# Receipt to Crypto

**QVAC** (local OCR + small LLM) turns a receipt image into editable fields (merchant, total, category). **Tether WDK** optionally sends **USDT** on Solana after you confirm the recipient and amount.

## For judges (demo checklist)

1. **Environment** — Confirm pills in the header: cluster (e.g. Devnet), Mock vs local AI, wallet ready/off.
2. **Upload** — Drop or select a JPEG/PNG/WebP receipt → **Run extraction** (or **Ctrl+Enter** / **⌘+Enter** with a file selected).
3. **Review** — Scrolls to OCR + preview; totals are inferred, not financial advice.
4. **Fields** — Edit any value; USDT base units update from the fiat total when you change it.
5. **Settlement** — Paste devnet recipient, set amount, check confirmation, **Send USDT** → copy signature or open **Solana Explorer**.

**Architecture (honest scope):** Vite UI + Express API on your machine. Receipt bytes hit the **local** API; QVAC runs there (or mock mode without models). Nothing is sent to a cloud LLM for extraction. Static hosts (e.g. Vercel-only static) do not serve `/api`; run `npm run dev` or `npm start` for the full loop.

## Requirements

- Node.js **≥ 22.17**
- Windows: Vulkan-capable GPU for real QVAC (set `USE_MOCK_AI=true` to skip models)

## Setup

```bash
cp .env.example .env
# Edit .env: WALLET_SEED, USDT_MINT for devnet pay tests; set USE_MOCK_AI=false for real QVAC
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

## Vercel

Import this repo in [Vercel](https://vercel.com): build runs `npm run build` and static output is `client/dist` (see `vercel.json`). The UI calls `/api/*`; on a static deployment those routes are not served unless you add a separate backend or serverless routes, so point the production UI at your API host or use Vercel only for the frontend demo.

## Links

- **Source:** [github.com/panagot/Tether-Receipt-to-Crypto](https://github.com/panagot/Tether-Receipt-to-Crypto)
