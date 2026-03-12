import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = 9000;

// Load .env
if (existsSync(join(__dirname, ".env"))) {
  const envLines = readFileSync(join(__dirname, ".env"), "utf-8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim();
  }
}

// Import function handlers
const { handler: processPaper } = await import("./netlify/functions/process-paper.js");
const { handler: processBibtex } = await import("./netlify/functions/process-bibtex.js");
const { handler: getPapers } = await import("./netlify/functions/get-papers.js");
const { handler: getNanopub } = await import("./netlify/functions/get-nanopub.js");
const { handler: publishNanopub } = await import("./netlify/functions/publish-nanopub.js");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API routes
  if (url.pathname === "/.netlify/functions/get-papers" && req.method === "GET") {
    const result = await getPapers({ httpMethod: "GET", headers: req.headers });
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
    return;
  }

  if (url.pathname === "/.netlify/functions/process-paper" && req.method === "POST") {
    const body = await collectBody(req);
    const event = {
      httpMethod: "POST",
      headers: req.headers,
      body: body.toString("utf-8"),
      isBase64Encoded: false,
    };
    const result = await processPaper(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
    return;
  }

  if (url.pathname === "/.netlify/functions/get-nanopub" && req.method === "GET") {
    const file = url.searchParams.get("file");
    const event = {
      httpMethod: "GET",
      headers: req.headers,
      queryStringParameters: { file },
    };
    const result = await getNanopub(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
    return;
  }

  if (url.pathname === "/.netlify/functions/publish-nanopub" && req.method === "POST") {
    const body = await collectBody(req);
    const event = {
      httpMethod: "POST",
      headers: req.headers,
      body: body.toString("utf-8"),
      isBase64Encoded: false,
    };
    const result = await publishNanopub(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
    return;
  }

  if (url.pathname === "/.netlify/functions/process-bibtex" && req.method === "POST") {
    const body = await collectBody(req);
    const event = {
      httpMethod: "POST",
      headers: req.headers,
      body: body.toString("utf-8"),
      isBase64Encoded: false,
    };
    const result = await processBibtex(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
    return;
  }

  // Static files
  let filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
});

server.listen(PORT, () => {
  console.log(`\n  FAIR2Adapt Claim Demo running at http://localhost:${PORT}\n`);
});
