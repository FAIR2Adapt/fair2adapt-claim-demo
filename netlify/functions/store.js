import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_FILE = join(process.cwd(), "data", "papers.json");
const IS_NETLIFY = !!process.env.NETLIFY;

// ---- Netlify Blobs (production) ----
async function getBlobStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("papers");
}

async function loadPapersBlob() {
  try {
    const store = await getBlobStore();
    const data = await store.get("papers.json");
    return data ? JSON.parse(data) : [];
  } catch (_) {
    return [];
  }
}

async function savePaperBlob(paper) {
  const papers = await loadPapersBlob();
  const idx = papers.findIndex((p) => p.id === paper.id);
  if (idx >= 0) {
    papers[idx] = paper;
  } else {
    papers.unshift(paper);
  }
  const store = await getBlobStore();
  await store.set("papers.json", JSON.stringify(papers, null, 2));
  return paper;
}

// ---- Local file (development) ----
function loadPapersLocal() {
  if (!existsSync(DATA_FILE)) return [];
  const raw = readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function savePaperLocal(paper) {
  const papers = loadPapersLocal();
  const idx = papers.findIndex((p) => p.id === paper.id);
  if (idx >= 0) {
    papers[idx] = paper;
  } else {
    papers.unshift(paper);
  }
  writeFileSync(DATA_FILE, JSON.stringify(papers, null, 2));
  return paper;
}

// ---- Exports: auto-detect environment ----
export async function loadPapers() {
  return IS_NETLIFY ? loadPapersBlob() : loadPapersLocal();
}

export async function savePaper(paper) {
  return IS_NETLIFY ? savePaperBlob(paper) : savePaperLocal(paper);
}
