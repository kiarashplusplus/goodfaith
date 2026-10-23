import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { getBase58Decoder } from "@solana/kit";
import { TEST_ADMIN_ADDRESS } from "./src/lib/svm/admin";

/**
 * On-chain tests: the app's own instruction builders and reads against the compiled program in LiteSVM.
 * Needs `anchor build --arch v2` first (target/deploy/goodfaith.so). Run with `npm run test:svm`.
 * The app config reads NEXT_PUBLIC_* at import time, so the fixtures' gatekeeper network and admin are set here.
 */
const civic = JSON.parse(readFileSync(new URL("../scripts/civic-token.json", import.meta.url), "utf8")) as { data: string };
// GatewayToken layout: version(1) parent-tag(1) owner(32) identity-tag(1) network(32) ...
const NETWORK = getBase58Decoder().decode(Buffer.from(civic.data, "hex").subarray(35, 67));

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["src/**/*.svm.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NEXT_PUBLIC_CLUSTER: "devnet",
      NEXT_PUBLIC_KORA_URL: "",
      NEXT_PUBLIC_GATEKEEPER_NETWORK: NETWORK,
      NEXT_PUBLIC_POOL_AUTHORITY: TEST_ADMIN_ADDRESS,
    },
  },
});
