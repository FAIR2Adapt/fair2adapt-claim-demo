import { savePaper } from "./store.js";
import { loginRoHub, getOrCreateClaimsFolder, createPaperRO, addROToFolder } from "./rohub.js";

// ---- Parse BibTeX to extract DOIs ----
function parseBibtex(text) {
  const entries = [];
  // Match @type{key, ... } blocks
  const entryRegex = /@\w+\s*\{[^@]*?\n\s*\}/gs;
  const matches = text.match(entryRegex) || [];

  for (const block of matches) {
    const doi = extractField(block, "doi");
    const title = extractField(block, "title");
    const abstract = extractField(block, "abstract");
    if (doi || title) {
      entries.push({ doi: doi ? doi.replace(/^https?:\/\/doi\.org\//, "") : null, title, abstract });
    }
  }

  // Also support plain DOI list (one per line)
  if (entries.length === 0) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const doiMatch = line.match(/\b(10\.\d{4,}\/[^\s,}]+)/);
      if (doiMatch) {
        entries.push({ doi: doiMatch[1], title: null, abstract: null });
      }
    }
  }

  return entries;
}

function extractField(block, field) {
  // Match field = {value} or field = "value"
  const regex = new RegExp(`${field}\\s*=\\s*[{"]([^}"]*)[}"]`, "i");
  const match = block.match(regex);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
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

// ---- Extract AIDA claims from text via claim_extraction ----
async function extractClaims(text) {
  try {
    const resp = await fetch(
      "https://labdemos.expertcustomers.ai/services/claim_extraction",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      }
    );
    if (!resp.ok) return [];
    const result = await resp.json();
    return Array.isArray(result) ? result : [];
  } catch (_) {
    return [];
  }
}

// ---- Main handler ----
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body);
    const bibtexText = body.bibtex || "";

    const entries = parseBibtex(bibtexText);
    if (entries.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No DOIs or BibTeX entries found." }),
      };
    }

    const results = [];

    // Login to RoHub once for all entries
    let token = null;
    let folderId = null;
    try {
      token = await loginRoHub();
      folderId = await getOrCreateClaimsFolder(token);
    } catch (err) {
      console.error("RoHub login error:", err.message);
    }

    for (const entry of entries) {
      try {
        // Get metadata (title + abstract)
        let title = entry.title || "Untitled";
        let abstract = entry.abstract || "";

        if (entry.doi) {
          const meta = await getPaperMetadata(entry.doi);
          if (meta) {
            title = meta.title || title;
            abstract = abstract || meta.abstract;
          }
        }

        // Extract claims from abstract
        let claims = [];
        if (abstract) {
          const rawClaims = await extractClaims(abstract);
          const seen = new Set();
          claims = rawClaims
            .filter((c) => {
              if (!c.claim) return false;
              const key = c.claim.toLowerCase().trim();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((c) => ({
              sentence: c.claim,
              nanopub_uri: null,
            }));
        }

        // Create RoHub RO and add to claims folder
        let rohubUri = null;
        if (token && folderId) {
          try {
            const ro = await createPaperRO(token, {
              title,
              doi: entry.doi,
              claims,
              topics: [],
              tags: [],
            });
            rohubUri = `https://w3id.org/ro-id/${ro.identifier}`;
            await addROToFolder(token, folderId, ro.identifier);
          } catch (err) {
            console.error(`RoHub error for ${entry.doi}:`, err.message);
          }
        }

        // Store result locally (backup)
        const paperId = entry.doi
          ? entry.doi.replace(/\//g, "_")
          : Date.now().toString() + Math.random().toString(36).slice(2, 6);

        const paperRecord = {
          id: paperId,
          doi: entry.doi,
          title,
          claims,
          topics: [],
          tags: [],
          rohub_uri: rohubUri,
          created_at: new Date().toISOString(),
        };

        await savePaper(paperRecord);
        results.push(paperRecord);
      } catch (err) {
        console.error(`Error processing ${entry.doi || entry.title}:`, err.message);
        // Continue with next entry
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        processed: results.length,
        total: entries.length,
        papers: results,
      }),
    };
  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: err.message }),
    };
  }
}
