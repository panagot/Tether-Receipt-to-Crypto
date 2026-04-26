# Receipt to Crypto

Local **QVAC** (OCR + LLM) extracts merchant, total, and category from a receipt image. Optional **WDK** sends **USDT** on Solana after you confirm amounts.

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
