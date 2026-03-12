import { loadPapers } from "./store.js";

export async function handler() {
  try {
    const papers = await loadPapers();
    // Already sorted newest first (unshift on save)
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(papers),
    };
  } catch (err) {
    console.error("Error loading papers:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: err.message }),
    };
  }
}
