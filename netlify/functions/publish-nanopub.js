import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const IS_NETLIFY = !!process.env.NETLIFY || process.cwd().startsWith("/var/task");
const NANOPUB_DIR = IS_NETLIFY ? "/tmp/nanopubs" : join(process.cwd(), "data", "nanopubs");

// Read private key: either a file path (local dev) or base64 content (Netlify env)
function getPrivateKey() {
  const val = process.env.NANOPUB_PRIVATE_KEY || "";
  if (!val) return "";
  // If it looks like a file path, read the file
  if (val.startsWith("/") && existsSync(val)) {
    const raw = readFileSync(val, "utf-8");
    return raw
      .replace(/-----BEGIN .*-----/g, "")
      .replace(/-----END .*-----/g, "")
      .replace(/\s+/g, "");
  }
  // Otherwise treat as base64 content directly
  return val;
}
const AGENT_URI = process.env.NANOPUB_AGENT_URI || "";
const AGENT_NAME = process.env.NANOPUB_AGENT_NAME || "claude-ai-agent";

// Nanopub server — production registry (where ScienceLive reads from)
const NANOPUB_SERVER = process.env.NANOPUB_SERVER || "https://registry.knowledgepixels.com/np/";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  try {
    const { file, isExample } = JSON.parse(event.body);

    if (!file || file.includes("..") || file.includes("/")) {
      return { statusCode: 400, body: JSON.stringify({ message: "Invalid filename" }) };
    }

    const filepath = join(NANOPUB_DIR, file);
    if (!existsSync(filepath)) {
      return { statusCode: 404, body: JSON.stringify({ message: "Nanopub not found" }) };
    }

    let trig = readFileSync(filepath, "utf-8");

    // Update example flag in the TriG
    if (isExample === false) {
      trig = trig.replace(/\s*npx:hasNanopubType npx:ExampleNanopub ;\n/g, "\n");
    } else if (isExample === true && !trig.includes("npx:ExampleNanopub")) {
      trig = trig.replace(
        /(npx:hasNanopubType [^;]+;)/,
        "$1\n        npx:hasNanopubType npx:ExampleNanopub ;"
      );
    }

    // Save updated TriG
    writeFileSync(filepath, trig, "utf-8");

    // Read private key
    const privateKey = getPrivateKey();
    if (!privateKey) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "NANOPUB_PRIVATE_KEY path not configured or file not found. Set it in .env.",
          published: false,
          nanopub_uri: null,
        }),
      };
    }

    // Sign and publish with nanopub-js
    const { sign, NanopubClass } = await import("@nanopub/nanopub-js");

    // sign(rdf, privateKey) — no orcid for software agents
    const { signedRdf, sourceUri } = await sign(trig, privateKey, undefined, undefined);

    // Save the signed TriG
    const signedFile = file.replace(".trig", ".signed.trig");
    writeFileSync(join(NANOPUB_DIR, signedFile), signedRdf, "utf-8");

    // Publish the signed nanopub
    const np = NanopubClass.fromRdf(signedRdf);
    await np.publish(NANOPUB_SERVER);
    // Use sourceUri from sign() as the published URI
    const nanopubUri = sourceUri;
    console.log(`Published nanopub: ${nanopubUri}`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Nanopub published successfully.",
        published: true,
        nanopub_uri: nanopubUri,
      }),
    };
  } catch (err) {
    console.error("Publish error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: err.message }),
    };
  }
}
