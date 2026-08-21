// Baut src/ nach dist/: bündelt die Options-Module mit esbuild, kopiert den
// Rest (Manifest, Content-Scripts, HTML, Icons) unverändert. `--watch` hält
// esbuild im Watch-Modus und beobachtet die statischen Dateien per fs.watch.
import { build, context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { watch } from "node:fs";

const SRC = "src";
const DIST = "dist";
const STATIC_FILES = ["manifest.json", "background.js", "main.js", "zdf_api.js", "options.html", "popup.html", "popup.js", "reco_ids.json"];
const STATIC_DIRS = ["icons"];

async function copyStatic() {
  await mkdir(DIST, { recursive: true });
  for (const f of STATIC_FILES) await cp(`${SRC}/${f}`, `${DIST}/${f}`);
  for (const d of STATIC_DIRS) await cp(`${SRC}/${d}`, `${DIST}/${d}`, { recursive: true });
}

const esbuildOpts = {
  entryPoints: [`${SRC}/options/index.js`],
  outfile: `${DIST}/options.js`,
  bundle: true,
  format: "iife",
  target: "chrome110",
};

const watchMode = process.argv.includes("--watch");

if (watchMode) {
  await copyStatic();
  const ctx = await context(esbuildOpts);
  await ctx.watch();

  let pending = false;
  watch(SRC, { recursive: true }, () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { pending = false; await copyStatic(); console.log("[build] static files updated"); }, 100);
  });
  console.log("[build] watching for changes...");
} else {
  await copyStatic();
  await build(esbuildOpts);
  console.log("[build] done -> dist/");
}
