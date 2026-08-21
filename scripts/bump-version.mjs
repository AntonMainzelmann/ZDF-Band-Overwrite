// Bumpt die Patch-Version in src/manifest.json vor jedem Package-Build —
// Chrome Web Store und AMO lehnen ein erneutes Upload derselben Version ab.
import { readFile, writeFile } from "node:fs/promises";

const path = "src/manifest.json";
const manifest = JSON.parse(await readFile(path, "utf8"));

const parts = manifest.version.split(".").map(Number);
parts[parts.length - 1] += 1;
manifest.version = parts.join(".");

await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[bump-version] manifest.json -> ${manifest.version}`);
