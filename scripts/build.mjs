import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import "./check.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
for (const file of ["index.html", "favicon.svg", "src"])
  await cp(`${root}/${file}`, `${root}/dist/${file}`, { recursive: true });
const html = await readFile(`${root}/dist/index.html`);
await writeFile(
  `${root}/dist/build.json`,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      entryHash: createHash("sha256").update(html).digest("hex"),
    },
    null,
    2,
  ),
);
console.log("Static build created in dist/.");
