// RoHub API integration
// Parent RO: https://w3id.org/ro-id/2cace03a-fa6d-450a-9192-dd17fe85a941

const ROHUB_API = "https://api.rohub.org/api";
const PARENT_RO_ID = "2cace03a-fa6d-450a-9192-dd17fe85a941";

// ---- Authentication ----
export async function loginRoHub() {
  const resp = await fetch(`${ROHUB_API}/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.ROHUB_USERNAME,
      password: process.env.ROHUB_PASSWORD,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RoHub login failed: ${text}`);
  }
  const data = await resp.json();
  return data.token;
}

// ---- Get or create the "claims" folder in the parent RO ----
export async function getOrCreateClaimsFolder(token) {
  // List existing folders
  const listResp = await fetch(
    `${ROHUB_API}/ros/${PARENT_RO_ID}/folders/`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (listResp.ok) {
    const data = await listResp.json();
    const existing = (data.results || []).find(
      (f) => f.name === "claims"
    );
    if (existing) return existing.identifier;
  }

  // Create folder
  const createResp = await fetch(
    `${ROHUB_API}/ros/${PARENT_RO_ID}/folders/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: "claims",
        description: "Collection of papers with extracted AIDA claims",
      }),
    }
  );

  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`Failed to create claims folder: ${text}`);
  }

  const folder = await createResp.json();
  return folder.identifier;
}

// ---- Create a per-paper Research Object ----
export async function createPaperRO(token, { title, doi, claims, topics, tags }) {
  // Build description from claims
  const claimsList = claims
    .map((c) => `- ${c.sentence}`)
    .join("\n");
  const description = `AIDA claims extracted from: ${title}\n\nDOI: ${doi || "N/A"}\n\nClaims:\n${claimsList}`;

  const resp = await fetch(`${ROHUB_API}/ros/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: title,
      description: description,
      research_areas: ["Earth sciences"],
      ros_type: "Bibliography-centric Research Object",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RoHub RO creation failed: ${text}`);
  }

  const ro = await resp.json();

  // Add DOI as external resource
  if (doi) {
    await addExternalResource(token, ro.identifier, `https://doi.org/${doi}`, title);
  }

  // Add nanopub URIs as external resources
  for (const claim of claims) {
    if (claim.nanopub_uri) {
      await addExternalResource(
        token,
        ro.identifier,
        claim.nanopub_uri,
        `AIDA Claim: ${claim.sentence.substring(0, 80)}...`
      );
    }
  }

  // Add keywords from tags
  const keywords = ["FAIR2Adapt", "AIDA claims"];
  if (tags) {
    for (const t of tags) {
      keywords.push(t.value);
    }
  }
  await addKeywords(token, ro.identifier, keywords);

  return ro;
}

// ---- Add external resource to an RO ----
async function addExternalResource(token, roId, url, title) {
  try {
    await fetch(`${ROHUB_API}/ros/${roId}/resources/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        resource_type: "External Resource",
        url: url,
        title: title,
      }),
    });
  } catch (err) {
    console.error(`Failed to add resource ${url}:`, err.message);
  }
}

// ---- Add keywords to an RO ----
async function addKeywords(token, roId, keywords) {
  try {
    await fetch(`${ROHUB_API}/ros/${roId}/annotations/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        annotation_type: "keywords",
        body: keywords,
      }),
    });
  } catch (err) {
    console.error("Failed to add keywords:", err.message);
  }
}

// ---- Add a paper RO to the claims folder ----
export async function addROToFolder(token, folderId, paperRoId) {
  try {
    await fetch(
      `${ROHUB_API}/ros/${PARENT_RO_ID}/folders/${folderId}/resources/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          resource_type: "External Resource",
          url: `https://w3id.org/ro-id/${paperRoId}`,
          title: "Paper Research Object",
        }),
      }
    );
  } catch (err) {
    console.error("Failed to add RO to folder:", err.message);
  }
}

// ---- List all paper ROs from the claims folder ----
export async function listClaimsPapers(token) {
  const folderId = await getOrCreateClaimsFolder(token);

  const resp = await fetch(
    `${ROHUB_API}/ros/${PARENT_RO_ID}/folders/${folderId}/resources/`,
    {
      headers: {
        Authorization: token ? `Bearer ${token}` : undefined,
      },
    }
  );

  if (!resp.ok) return [];

  const data = await resp.json();
  return data.results || [];
}

export { PARENT_RO_ID };
