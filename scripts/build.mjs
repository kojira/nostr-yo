// Reproducible build: bundle src/ with esbuild into dist/ (or tests into dist-test/).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readdirSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const test = process.argv.includes("--test");
const common = { bundle: true, format: "esm", target: "es2022", legalComments: "eof", logLevel: "warning", sourcemap: false, charset: "utf8" };

if (test) {
  rmSync("dist-test", { recursive: true, force: true });
  const entries = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  await build({ ...common, entryPoints: entries, outdir: "dist-test", platform: "node", external: ["node:*"], outExtension: { ".js": ".mjs" } });
} else {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist");
  await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/app.js", platform: "browser", minify: true });
  for (const f of ["index.html", "style.css"]) cpSync(`web/${f}`, `dist/${f}`);
  cpSync("web/.nojekyll", "dist/.nojekyll");
  for (const f of readdirSync("dist")) {
    const h = createHash("sha256").update(readFileSync(`dist/${f}`)).digest("hex");
    console.log(`${h}  ${f}`);
  }
}
