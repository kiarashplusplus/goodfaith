# Good Faith web app

Next.js (App Router) + Tailwind. Wallet via Wallet Standard (`@solana/kit-plugin-wallet`), RPC via `@solana/kit`,
program client generated with Codama, Civic Pass via `@civic/solana-gateway-react`, optional Kora fee sponsorship.

```
cp .env.example .env.local   # then edit
npm install
npm run dev        # http://localhost:3000
npm run codegen    # regenerate src/generated from ../target/idl/goodfaith.json (run after `anchor build`)
npm run build && npm run lint && npm run typecheck && npm test
```

Set `NEXT_PUBLIC_GATEKEEPER_NETWORK` (or rely on the value stored in the pool) and `NEXT_PUBLIC_KORA_URL`
(leave empty to have users pay their own fees).
