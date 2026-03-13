import { readFileSync, existsSync } from "node:fs";

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

// Nanopub server — production registry (where ScienceLive reads from)
const NANOPUB_SERVER = process.env.NANOPUB_SERVER || "https://registry.knowledgepixels.com/np/";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  try {
    const { trig: trigInput, isExample } = JSON.parse(event.body);

    if (!trigInput) {
      return { statusCode: 400, body: JSON.stringify({ message: "No TriG content provided" }) };
    }

    let trig = trigInput;

    // Update example flag in the TriG
    if (isExample === false) {
      trig = trig.replace(/\s*npx:hasNanopubType npx:ExampleNanopub ;\n/g, "\n");
    } else if (isExample === true && !trig.includes("npx:ExampleNanopub")) {
      trig = trig.replace(
        /(npx:hasNanopubType [^;]+;)/,
        "$1\n        npx:hasNanopubType npx:ExampleNanopub ;"
      );
    }

    // Read private key
    const privateKey = getPrivateKey();
    if (!privateKey) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "NANOPUB_PRIVATE_KEY not configured. Set it in environment variables.",
          published: false,
          nanopub_uri: null,
        }),
      };
    }

    // Sign and publish with nanopub-js
    const { sign, NanopubClass } = await import("@nanopub/nanopub-js");

    // sign(rdf, privateKey) — no orcid for software agents
    const { signedRdf, sourceUri } = await sign(trig, privateKey, undefined, undefined);

    // Publish the signed nanopub
    const np = NanopubClass.fromRdf(signedRdf);
    await np.publish(NANOPUB_SERVER);
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
