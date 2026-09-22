import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, "http://localhost");
    const name = decodeURIComponent(url.pathname);
    if (
      name.includes("..") ||
      name.includes("\\") ||
      !(
        name === "/" ||
        name === "/index.html" ||
        name === "/favicon.svg" ||
        /^\/src\/[a-z-]+\.(js|css)$/.test(name)
      )
    ) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const file = path.join(root, name === "/" ? "index.html" : name.slice(1));
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `Port ${port} is already in use. Choose another PORT.`
      : "Server failed to start.",
  );
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Local prototype: http://127.0.0.1:${port}`),
);
