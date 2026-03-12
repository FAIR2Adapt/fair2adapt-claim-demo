import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const IS_NETLIFY = !!process.env.NETLIFY || process.cwd().startsWith("/var/task");
const DATA_FILE = IS_NETLIFY ? "/tmp/papers.json" : join(process.cwd(), "data", "papers.json");

function loadPapersFromFile() {
  if (!existsSync(DATA_FILE)) return [];
  const raw = readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function savePaperToFile(paper) {
  const dir = dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const papers = loadPapersFromFile();
  const idx = papers.findIndex((p) => p.id === paper.id);
  if (idx >= 0) {
    papers[idx] = paper;
  } else {
    papers.unshift(paper);
  }
  writeFileSync(DATA_FILE, JSON.stringify(papers, null, 2));
  return paper;
}

export async function loadPapers() {
  return loadPapersFromFile();
}

export async function savePaper(paper) {
  return savePaperToFile(paper);
}
