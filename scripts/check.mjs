import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const dir of ["src", "scripts", "tests"])
  for (const name of await readdir(`${root}/${dir}`))
    if (/\.(js|mjs)$/.test(name)) {
      const r = spawnSync(
        process.execPath,
        ["--check", `${root}/${dir}/${name}`],
        { stdio: "inherit" },
      );
      if (r.status !== 0) process.exit(r.status || 1);
    }
console.log("JavaScript syntax checks passed.");
