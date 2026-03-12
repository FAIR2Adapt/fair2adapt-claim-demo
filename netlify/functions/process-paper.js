import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Busboy from "busboy";
import pdf from "pdf-parse";
import { savePaper } from "./store.js";
import { loginRoHub, getOrCreateClaimsFolder, createPaperRO, addROToFolder } from "./rohub.js";
import { generateAIDANanopub, generateQuoteNanopub } from "./nanopub.js";

const IS_NETLIFY = !!process.env.NETLIFY;
const NANOPUB_DIR = IS_NETLIFY ? "/tmp/nanopubs" : join(process.cwd(), "data", "nanopubs");

// ---- ENV VARS (set in Netlify dashboard or .env) ----
// NANOPUB_PRIVATE_KEY  - software agent RSA private key
// NANOPUB_AGENT_URI    - e.g. https://w3id.org/np/RAIA.../claude-ai-agent
// NANOPUB_AGENT_NAME   - e.g. claude-ai-agent
// ROHUB_USERNAME
// ROHUB_PASSWORD

// ---- Parse multipart form data ----
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    // Netlify may use different header casing
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType) return reject(new Error("Missing content-type header"));
    const busboy = Busboy({
      headers: { "content-type": contentType },
    });

    let fileBuffer = null;
    let fileName = null;

    busboy.on("file", (_fieldname, file, info) => {
      fileName = info.filename;
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", () => {
      if (!fileBuffer) return reject(new Error("No file uploaded"));
      resolve({ buffer: fileBuffer, filename: fileName });
    });

    busboy.on("error", reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body);
    busboy.end(body);
  });
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

// ---- Call FAIR2Adapt enrich service (accepts full PDF) ----
async function enrichPaper(pdfBuffer, filename) {
  // Build multipart/form-data manually
  const boundary = "----FormBoundary" + Date.now().toString(36);
  const name = filename || "paper.pdf";

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, pdfBuffer, footer]);

  const resp = await fetch(
    "https://fair2adapt.expertcustomers.ai/services/enrich",
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!resp.ok) {
    throw new Error(`Enrich service failed: ${resp.status}`);
  }

  return resp.json();
}

// ---- Expand a text snippet to full sentence boundaries ----
function expandToSentence(snippet, fullText) {
  const cleaned = snippet.replace(/\s+/g, " ").trim();
  // Try to find the snippet in the full text (normalized)
  const normalizedFull = fullText.replace(/\s+/g, " ");
  const idx = normalizedFull.indexOf(cleaned);

  if (idx === -1) {
    // Snippet not found — just try to trim to nearest sentence-like boundaries
    return cleaned.replace(/^[^A-Z]*/, "").replace(/[^.!?]*$/, "").trim() || cleaned;
  }

  // Expand backward to the start of the sentence (find last ". " or start of text)
  let start = idx;
  while (start > 0) {
    const ch = normalizedFull[start - 1];
    if (ch === "." || ch === "!" || ch === "?") {
      // Check it's a real sentence end (followed by space + uppercase or our snippet)
      if (start < normalizedFull.length && /\s/.test(normalizedFull[start])) {
        break;
      }
    }
    start--;
  }

  // Expand forward to the end of the sentence (find next ". " or end of text)
  let end = idx + cleaned.length;
  while (end < normalizedFull.length) {
    const ch = normalizedFull[end];
    if ((ch === "." || ch === "!" || ch === "?") && (end + 1 >= normalizedFull.length || /\s/.test(normalizedFull[end + 1]))) {
      end++; // include the period
      break;
    }
    end++;
  }

  return normalizedFull.slice(start, end).trim();
}

// ---- Extract claims and metadata from enrich response ----
function parseEnrichResponse(enrichData, fullText) {
  const data = enrichData.response || enrichData;

  // Key sentences — expand to full sentence boundaries using PDF text
  const keySentences = (data.ke_sentences || []).map((s) => {
    const raw = s.key_element.replace(/\s+/g, " ").trim();
    const expanded = fullText ? expandToSentence(raw, fullText) : raw;
    return {
      sentence: expanded,
      score: s.normScore || s.score || 0,
    };
  });

  // Sort by score descending
  keySentences.sort((a, b) => b.score - a.score);

  // Deduplicate sentences that expanded to the same text
  const seenSentences = new Set();
  const uniqueSentences = keySentences.filter((s) => {
    if (seenSentences.has(s.sentence)) return false;
    seenSentences.add(s.sentence);
    return true;
  });

  // Locations with Wikidata URIs for nanopub topics
  const topics = (data.entity_locations || [])
    .filter((e) => e.wikidata)
    .map((e) => ({
      label: e.entity,
      uri: e.wikidata,
    }));

  // Deduplicate topics by URI
  const seenUris = new Set();
  const uniqueTopics = topics.filter((t) => {
    if (seenUris.has(t.uri)) return false;
    seenUris.add(t.uri);
    return true;
  });

  // Climate adaptation tags
  const tags = (data.tags_fcid || []).map((t) => ({
    tag: t.tag,
    value: t.value,
  }));

  return {
    claims: uniqueSentences,
    topics: uniqueTopics,
    tags,
  };
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
    console.log("Processing PDF upload. Body length:", event.body?.length, "Base64:", event.isBase64Encoded);
    // 1. Parse uploaded PDF
    const { buffer, filename } = await parseMultipart(event);
    console.log("Parsed PDF:", filename, "Size:", buffer.length);

    // 2. Extract DOI from PDF text for metadata lookup
    const pdfData = await pdf(buffer);
    const doi = extractDOI(pdfData.text);
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
      // Try to extract abstract section from PDF text
      // Try multiple patterns: "Abstract" followed by text, ending at Keywords/Introduction/section number
      const normalizedText = pdfData.text.replace(/\r\n/g, "\n");
      const absMatch = normalizedText.match(/\babstract\b[:\.\s]*\n?([\s\S]{50,3000}?)(?:\n\s*(?:keywords?\b|key\s*words?\b|introduction\b|1[\.\s]))/i)
        || normalizedText.match(/\babstract\b[:\.\s]*\n?([\s\S]{50,2000}?)\n\n/i);
      if (absMatch) {
        abstract = absMatch[1].replace(/\s+/g, " ").trim();
        console.log(`Extracted abstract from PDF text (${abstract.length} chars)`);
      } else {
        // Last resort: skip headers, take a chunk
        abstract = normalizedText.slice(300, 2300).replace(/\s+/g, " ").trim();
        console.log(`Using PDF text fallback (${abstract.length} chars)`);
      }
    } else {
      console.log(`Got abstract from metadata (${abstract.length} chars)`);
    }

    // 4. Send full PDF to enrich service (for quotes + topics + tags)
    let keySentences = [];
    let topics = [];
    let tags = [];

    try {
      const enrichResult = await enrichPaper(buffer, filename);
      const parsed = parseEnrichResponse(enrichResult, pdfData.text);
      keySentences = parsed.claims;
      topics = parsed.topics;
      tags = parsed.tags;
    } catch (enrichErr) {
      console.error("Enrich service unavailable, skipping quotes:", enrichErr.message);
    }

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
