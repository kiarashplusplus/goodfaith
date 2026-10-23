import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  // *.svm.test.ts need the built program (target/deploy/goodfaith.so); run them with `npm run test:svm`.
  test: { include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", "src/**/*.svm.test.ts"] },
});
