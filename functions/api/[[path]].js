// Cloudflare Pages routes every /api/* request here; the handler itself lives
// in src/worker.js so the tests and the local mock can import it directly.
import worker from "../../src/worker.js";

export const onRequest = ({ request, env }) => worker.fetch(request, env);
