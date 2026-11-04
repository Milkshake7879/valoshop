// Local preview with a fake Riot: `npm run mock`, open http://localhost:8787,
// and paste anything containing #access_token=a.b.c&id_token=d.e.f.
// Riot's endpoints are faked (test/fixtures.js); valorant-api.com is real.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/worker.js";
import { fakeRiot } from "./fixtures.js";

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const PORT = Number(process.env.PORT ?? 8787);

globalThis.fetch = fakeRiot({ realFetch: globalThis.fetch });

// Apply public/_headers so the CSP is exercised the same way as in production.
const headers = Object.fromEntries(
  (await readFile(join(PUBLIC, "_headers"), "utf8"))
    .split("\n").filter((l) => /^\s+\S+:/.test(l))
    .map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const ASSETS = {
  async fetch(request) {
    let path = new URL(request.url).pathname;
    if (path === "/") path = "/index.html";
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC) || path.endsWith("_headers")) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await worker.fetch(request, { ASSETS });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`Mock shop on http://localhost:${PORT}`));
