import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const IS_NETLIFY = !!process.env.NETLIFY || process.cwd().startsWith("/var/task");
const NANOPUB_DIR = IS_NETLIFY ? "/tmp/nanopubs" : join(process.cwd(), "data", "nanopubs");

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const filename = event.queryStringParameters?.file;
  if (!filename || filename.includes("..") || filename.includes("/")) {
    return { statusCode: 400, body: JSON.stringify({ message: "Invalid filename" }) };
  }

  const filepath = join(NANOPUB_DIR, filename);
  if (!existsSync(filepath)) {
    return { statusCode: 404, body: JSON.stringify({ message: "Nanopub not found" }) };
  }

  const trig = readFileSync(filepath, "utf-8");
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/trig; charset=utf-8" },
    body: trig,
  };
}
