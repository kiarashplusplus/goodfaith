// Generates a typed TypeScript client into src/generated from the Anchor IDL.
// Usage: npm run codegen   (IDL path override: IDL=path/to/goodfaith.json npm run codegen)
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const idlPath = process.env.IDL ?? path.resolve(here, "../../target/idl/goodfaith.json");
const outDir = path.resolve(here, "../src/generated");

if (!existsSync(idlPath)) {
  console.error(`IDL not found at ${idlPath}. Run \`anchor build\` first.`);
  process.exit(1);
}
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
// The renderer emits a package (<out>/src/generated); flatten it so imports are "@/generated".
const tmp = mkdtempSync(path.join(os.tmpdir(), "gf-codegen-"));
await codama.accept(renderVisitor(tmp, { deleteFolderBeforeRendering: true, formatCode: false }));
rmSync(outDir, { recursive: true, force: true });
cpSync(path.join(tmp, "src", "generated"), outDir, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
console.log(`Generated client in ${outDir}`);
