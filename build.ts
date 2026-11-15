#!/usr/bin/env bun
/**
 * Build de production : application monopage statique dans dist/.
 * Seules les variables BUN_PUBLIC_* sont inlinées dans le bundle (CLAUDE.md §7).
 */
import plugin from "bun-plugin-tailwind";
import { rm } from "fs/promises";
import path from "path";

const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

const entrypoints = [...new Bun.Glob("**/*.html").scanSync("src")].map(file => path.resolve("src", file));

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [plugin],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  env: "BUN_PUBLIC_*",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} Ko`);
}
