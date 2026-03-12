import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { savePaper } from "./store.js";
import { loginRoHub, getOrCreateClaimsFolder, createPaperRO, addROToFolder } from "./rohub.js";
import { generateAIDANanopub, generateQuoteNanopub } from "./nanopub.js";

const IS_NETLIFY = !!process.env.NETLIFY || process.cwd().startsWith("/var/task");
const NANOPUB_DIR = IS_NETLIFY ? "/tmp/nanopubs" : join(process.cwd(), "data", "nanopubs");

// ---- ENV VARS (set in Netlify dashboard or .env) ----
// NANOPUB_PRIVATE_KEY  - software agent RSA private key
// NANOPUB_AGENT_URI    - e.g. https://w3id.org/np/RAIA.../claude-ai-agent
// NANOPUB_AGENT_NAME   - e.g. claude-ai-agent
// ROHUB_USERNAME
// ROHUB_PASSWORD

// ---- Parse text + filename from JSON body ----
function parseBodyText(event) {
  const body = JSON.parse(event.body);
  if (!body.pdfText) throw new Error("No PDF text provided");
  return { pdfText: body.pdfText, filename: body.filename || "paper.pdf" };
}

// ---- Extract DOI from PDF text ----
function extractDOI(text) {
  const doiMatch = text.match(/\b(10\.\d{4,}\/[^\s]+)/);
  return doiMatch ? doiMatch[1].replace(/[.,;)]+$/, "") : null;
}

// ---- Get paper metadata from Crossref or DataCite ----
async function getPaperMetadata(doi) {
  try {
    const resp = await fetch(`https://api.crossref.org/works/${doi}`, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const data = (await resp.json()).message;
      return {
        title: (data.title || [])[0] || "Untitled",
        abstract: (data.abstract || "").replace(/<[^>]*>/g, ""),
      };
    }
  } catch (_) {}

  try {
    const resp = await fetch(`https://api.datacite.org/dois/${doi}`, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const attrs = (await resp.json()).data.attributes;
      const title = (attrs.titles || [{}])[0].title || "Untitled";
      const desc = (attrs.descriptions || []).find(
        (d) => d.descriptionType === "Abstract"
      );
      return {
        title,
        abstract: desc ? desc.description.replace(/<[^>]*>/g, "") : "",
      };
    }
  } catch (_) {}

  return null;
}


// ---- Reformulate key sentences into AIDA claims via claim_extraction ----
// Sends all sentences concatenated together for better consolidated claims
async function reformulateClaims(keySentences) {
  const allText = keySentences.map((ks) => ks.sentence).join(". ");
  console.log(`Sending ${allText.length} chars to claim_extraction`);

  try {
    const resp = await fetch(
      "https://labdemos.expertcustomers.ai/services/claim_extraction",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: allText,
      }
    );

    if (!resp.ok) {
      console.error("Claim extraction failed:", resp.status);
      return [];
    }

    const result = await resp.json();
    const rawClaims = Array.isArray(result) ? result : [];
    console.log(`Claim extraction returned ${rawClaims.length} claims`);

    // Deduplicate claims by normalized text
    const seen = new Set();
    return rawClaims
      .filter((c) => {
        if (!c.claim) return false;
        const key = c.claim.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c) => ({
        sentence: c.claim,
      }));
  } catch (err) {
    console.error("Claim extraction error:", err.message);
    return [];
  }
}

// ---- Extract a comment for a single key sentence via claim_extraction ----
async function extractCommentForSentence(sentence) {
  try {
    const resp = await fetch(
      "https://labdemos.expertcustomers.ai/services/claim_extraction",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: sentence,
      }
    );
    if (!resp.ok) return null;
    const result = await resp.json();
    if (Array.isArray(result) && result.length > 0 && result[0].claim) {
      return result[0].claim;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ---- Save TriG file to data/nanopubs/ ----
function saveNanopubTriG(paperId, index, type, trig) {
  if (!existsSync(NANOPUB_DIR)) {
    mkdirSync(NANOPUB_DIR, { recursive: true });
  }
  const filename = `${paperId}_${type}_${index}.trig`;
  const filepath = join(NANOPUB_DIR, filename);
  writeFileSync(filepath, trig, "utf-8");
  console.log(`Saved nanopub: ${filename}`);
  return filepath;
}

// ---- Generate nanopub TriG for both types and save to disk ----
// Returns { aidaNanopubs: [...], quoteNanopubs: [...] }
async function generateAllNanopubs(keySentences, aidaClaims, doi, topics) {
  const paperId = doi ? doi.replace(/\//g, "_") : Date.now().toString();

  const aidaNanopubs = aidaClaims.map((claim, i) => {
    const trig = generateAIDANanopub({ claim: claim.sentence, doi, topics });
    const filename = `${paperId}_aida_${i + 1}.trig`;
    saveNanopubTriG(paperId, i + 1, "aida", trig);
    return {
      sentence: claim.sentence,
      type: "aida",
      trig_file: filename,
      nanopub_uri: null,
    };
  });

  // Per-sentence: get comment for each key sentence → quote nanopub
  const quoteNanopubs = [];
  let quoteIndex = 0;
  for (const ks of keySentences) {
    const comment = await extractCommentForSentence(ks.sentence);
    if (comment && doi) {
      const trig = generateQuoteNanopub({
        quotation: ks.sentence,
        comment,
        doi,
      });
      if (trig) {
        quoteIndex++;
        const filename = `${paperId}_quote_${quoteIndex}.trig`;
        saveNanopubTriG(paperId, quoteIndex, "quote", trig);
        quoteNanopubs.push({
          quotation: ks.sentence,
          comment,
          type: "quote",
          trig_file: filename,
          nanopub_uri: null,
        });
      }
    }
  }

  return { aidaNanopubs, quoteNanopubs };
}

// ---- Main handler ----
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  try {
    console.log("Processing PDF text. Body length:", event.body?.length);

    // 1. Parse text from JSON body (extracted client-side via pdf.js)
    let pdfText, filename;
    try {
      ({ pdfText, filename } = parseBodyText(event));
      console.log("Received text from:", filename, "Length:", pdfText.length);
    } catch (parseErr) {
      console.error("Parse error:", parseErr.message);
      return { statusCode: 400, body: JSON.stringify({ message: "Failed to parse request: " + parseErr.message }) };
    }

    // 2. Extract DOI from PDF text for metadata lookup
    const doi = extractDOI(pdfText);
    let title = "Untitled";

    if (doi) {
      const meta = await getPaperMetadata(doi);
      if (meta) {
        title = meta.title;
      }
    }

    // 3. Get abstract for AIDA claims (always from Crossref/DataCite or PDF text)
    let abstract = "";
    if (doi) {
      const meta = await getPaperMetadata(doi);
      if (meta && meta.abstract) abstract = meta.abstract;
    }
    if (!abstract) {
      const normalizedText = pdfText.replace(/\r\n/g, "\n");
      const absMatch = normalizedText.match(/\babstract\b[:\.\s]*\n?([\s\S]{50,3000}?)(?:\n\s*(?:keywords?\b|key\s*words?\b|introduction\b|1[\.\s]))/i)
        || normalizedText.match(/\babstract\b[:\.\s]*\n?([\s\S]{50,2000}?)\n\n/i);
      if (absMatch) {
        abstract = absMatch[1].replace(/\s+/g, " ").trim();
        console.log(`Extracted abstract from PDF text (${abstract.length} chars)`);
      } else {
        abstract = normalizedText.slice(300, 2300).replace(/\s+/g, " ").trim();
        console.log(`Using PDF text fallback (${abstract.length} chars)`);
      }
    } else {
      console.log(`Got abstract from metadata (${abstract.length} chars)`);
    }

    // 4. Enrich service skipped (requires raw PDF binary, text extracted client-side)
    let keySentences = [];
    let topics = [];
    let tags = [];

    // 5. Extract AIDA claims from abstract (batch)
    if (!abstract) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No abstract could be found for this paper." }),
      };
    }

    const aidaClaims = await reformulateClaims([{ sentence: abstract }]);

    // 6. Generate nanopub TriG
    //    - AIDA nanopubs from abstract → claim_extraction
    //    - Quote+comment nanopubs from enrich key sentences (when available)
    const { aidaNanopubs, quoteNanopubs } = await generateAllNanopubs(
      keySentences, aidaClaims, doi, topics
    );

    // Combine claims for display (AIDA claims shown on the card)
    const publishedClaims = aidaNanopubs.map((np) => ({
      sentence: np.sentence,
      nanopub_uri: np.nanopub_uri,
      trig_file: np.trig_file,
      type: "aida",
    }));

    // Quote nanopubs also stored for reference
    const publishedQuotes = quoteNanopubs.map((np) => ({
      quotation: np.quotation,
      comment: np.comment,
      nanopub_uri: np.nanopub_uri,
      trig_file: np.trig_file,
      type: "quote",
    }));

    // Skip if nothing was extracted
    if (publishedClaims.length === 0 && publishedQuotes.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No claims or annotations could be generated from this paper." }),
      };
    }

    // 7. Create RoHub Research Object and add to claims folder
    let rohubUri = null;
    try {
      const token = await loginRoHub();
      const folderId = await getOrCreateClaimsFolder(token);
      const ro = await createPaperRO(token, {
        title,
        doi,
        claims: publishedClaims,
        topics,
        tags,
      });
      rohubUri = `https://w3id.org/ro-id/${ro.identifier}`;
      await addROToFolder(token, folderId, ro.identifier);
    } catch (err) {
      console.error("RoHub error:", err.message);
    }

    // 8. Store result locally (backup)
    const paperId = doi ? doi.replace(/\//g, "_") : Date.now().toString();
    const paperRecord = {
      id: paperId,
      doi,
      title,
      claims: publishedClaims,
      quotes: publishedQuotes,
      topics,
      tags,
      rohub_uri: rohubUri,
      created_at: new Date().toISOString(),
    };

    await savePaper(paperRecord);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paperRecord),
    };
  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: err.message }),
    };
  }
}
