const PAPERS_PER_PAGE = 5;
let currentPage = 1;
let allPapers = [];

// ---- DOM elements ----
const addPanel = document.getElementById("add-panel");
const addBtn = document.getElementById("add-btn");
const closePanel = document.getElementById("close-panel");
const form = document.getElementById("upload-form");
const fileInput = document.getElementById("pdf-file");
const submitBtn = document.getElementById("submit-btn");
const bibtexForm = document.getElementById("bibtex-form");
const bibtexFile = document.getElementById("bibtex-file");
const bibtexText = document.getElementById("bibtex-text");
const bibtexBtn = document.getElementById("bibtex-btn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const feedEl = document.getElementById("feed");
const paginationEl = document.getElementById("pagination");

// ---- Local storage helpers ----
function loadPapersLocal() {
  try {
    return JSON.parse(localStorage.getItem("fair2adapt_papers") || "[]");
  } catch (_) {
    return [];
  }
}

function savePapersLocal(papers) {
  localStorage.setItem("fair2adapt_papers", JSON.stringify(papers));
}

function addPaperLocal(paper) {
  const papers = loadPapersLocal();
  const idx = papers.findIndex((p) => p.id === paper.id);
  if (idx >= 0) {
    papers[idx] = paper;
  } else {
    papers.unshift(paper);
  }
  savePapersLocal(papers);
  return papers;
}

// ---- Panel toggle ----
addBtn.addEventListener("click", () => {
  addPanel.classList.remove("hidden");
  addBtn.style.display = "none";
});

closePanel.addEventListener("click", () => {
  addPanel.classList.add("hidden");
  addBtn.style.display = "";
  statusEl.className = "hidden";
  progressEl.classList.add("hidden");
});

// ---- Tab switching ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

// ---- Helpers ----
function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type;
}

function showProgress(percent, text) {
  progressEl.classList.remove("hidden");
  progressBar.style.width = percent + "%";
  progressText.textContent = text;
}

function hideProgress() {
  progressEl.classList.add("hidden");
}

// ---- PDF upload ----
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  submitBtn.disabled = true;
  showStatus("Processing PDF...", "info");
  showProgress(10, "Uploading...");

  try {
    showProgress(15, "Extracting text from PDF...");
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let pdfText = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      pdfText += content.items.map((item) => item.str).join(" ") + "\n";
    }
    showProgress(20, "Extracting claims (this may take a minute)...");

    const response = await fetch("/.netlify/functions/process-paper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfText, filename: file.name }),
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (_) {
      throw new Error(`Server returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(result.message || "Processing failed");
    }

    showStatus(`Extracted ${result.claims.length} AIDA claims.`, "success");
    showProgress(100, "Complete!");

    // Save to localStorage and refresh feed
    allPapers = addPaperLocal(result);
    currentPage = 1;
    renderCurrentPage();
    setTimeout(hideProgress, 2000);
  } catch (err) {
    showStatus("Error: " + err.message, "error");
    hideProgress();
  } finally {
    submitBtn.disabled = false;
  }
});

// ---- BibTeX upload ----
bibtexForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let bibtexContent = bibtexText.value.trim();

  if (bibtexFile.files[0]) {
    bibtexContent = await bibtexFile.files[0].text();
  }

  if (!bibtexContent) {
    showStatus("Please upload a BibTeX file or paste content.", "error");
    return;
  }

  bibtexBtn.disabled = true;
  showStatus("Processing BibTeX entries...", "info");
  showProgress(10, "Parsing...");

  try {
    showProgress(20, "Fetching metadata and extracting claims...");

    const response = await fetch("/.netlify/functions/process-bibtex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bibtex: bibtexContent }),
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (_) {
      throw new Error(`Server returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(result.message || "Processing failed");
    }

    showStatus(`Processed ${result.processed} of ${result.total} papers.`, "success");
    showProgress(100, "Complete!");

    // Save all papers to localStorage
    for (const paper of result.papers) {
      addPaperLocal(paper);
    }
    allPapers = loadPapersLocal();
    currentPage = 1;
    renderCurrentPage();
    setTimeout(hideProgress, 2000);
  } catch (err) {
    showStatus("Error: " + err.message, "error");
    hideProgress();
  } finally {
    bibtexBtn.disabled = false;
  }
});

// ---- Render a paper card ----
function renderPaperCard(paper) {
  const card = document.createElement("div");
  card.className = "paper-card";

  const date = new Date(paper.created_at).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // AIDA Claims
  let claimsHtml = "";
  if (paper.claims && paper.claims.length > 0) {
    const items = paper.claims
      .map((c, i) => {
        const id = `aida-${paper.id}-${i}`;
        if (c.nanopub_uri) {
          return `<li>
            <div class="np-sentence">${c.sentence}</div>
            <div class="np-actions">
              <a href="https://platform.sciencelive4all.org/np/?uri=${encodeURIComponent(c.nanopub_uri)}" target="_blank" rel="noopener" class="np-link">view on ScienceLive</a>
              <span class="np-published">published</span>
            </div>
          </li>`;
        }
        return `<li>
          <div class="np-sentence">${c.sentence}</div>
          <div class="np-actions">
            <label class="np-example"><input type="checkbox" checked data-id="${id}"> example</label>
            <button class="np-publish-btn" data-trig="${btoa(c.trig || "")}" data-id="${id}">publish</button>
          </div>
        </li>`;
      })
      .join("");
    claimsHtml = `<h4>AIDA Claims</h4><ul class="claims-list">${items}</ul>`;
  }

  // Quote annotations
  let quotesHtml = "";
  if (paper.quotes && paper.quotes.length > 0) {
    const items = paper.quotes
      .map((q, i) => {
        const id = `quote-${paper.id}-${i}`;
        if (q.nanopub_uri) {
          return `<li class="quote-item">
            <div class="quote-text">${q.quotation}</div>
            <div class="quote-comment">${q.comment}</div>
            <div class="np-actions">
              <a href="https://platform.sciencelive4all.org/np/?uri=${encodeURIComponent(q.nanopub_uri)}" target="_blank" rel="noopener" class="np-link">view on ScienceLive</a>
              <span class="np-published">published</span>
            </div>
          </li>`;
        }
        return `<li class="quote-item">
          <div class="quote-text">${q.quotation}</div>
          <div class="quote-comment">${q.comment}</div>
          <div class="np-actions">
            <label class="np-example"><input type="checkbox" checked data-id="${id}"> example</label>
            <button class="np-publish-btn" data-trig="${btoa(q.trig || "")}" data-id="${id}">publish</button>
          </div>
        </li>`;
      })
      .join("");
    quotesHtml = `<h4>Paper Annotations</h4><ul class="quotes-list">${items}</ul>`;
  }

  // Topics
  let topicsHtml = "";
  if (paper.topics && paper.topics.length > 0) {
    const items = paper.topics
      .map(
        (t) =>
          `<span class="topic-tag"><a href="${t.uri}" target="_blank" rel="noopener">${t.label}</a></span>`
      )
      .join(" ");
    topicsHtml = `<div class="topics">${items}</div>`;
  }

  // Tags
  let tagsHtml = "";
  if (paper.tags && paper.tags.length > 0) {
    const items = paper.tags
      .map((t) => `<span class="tag">${t.tag}: ${t.value}</span>`)
      .join(" ");
    tagsHtml = `<div class="tags">${items}</div>`;
  }

  // RoHub link
  let rohubHtml = "";
  if (paper.rohub_uri) {
    rohubHtml = `<a class="rohub-link" href="${paper.rohub_uri}" target="_blank" rel="noopener">View Research Object on RoHub</a>`;
  }

  const doiLink = paper.doi
    ? `<a href="https://doi.org/${paper.doi}" target="_blank" rel="noopener">${paper.title}</a>`
    : paper.title;

  card.innerHTML = `
    <h3>${doiLink}</h3>
    <div class="paper-date">${date}</div>
    ${tagsHtml}
    ${topicsHtml}
    ${claimsHtml}
    ${quotesHtml}
    ${rohubHtml}
  `;

  return card;
}

// ---- Pagination ----
function renderPagination() {
  paginationEl.innerHTML = "";
  const totalPages = Math.ceil(allPapers.length / PAPERS_PER_PAGE);
  if (totalPages <= 1) return;

  // Previous
  const prevBtn = document.createElement("button");
  prevBtn.textContent = "Previous";
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener("click", () => {
    currentPage--;
    renderCurrentPage();
  });
  paginationEl.appendChild(prevBtn);

  // Page numbers
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement("button");
    btn.textContent = i;
    if (i === currentPage) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentPage = i;
      renderCurrentPage();
    });
    paginationEl.appendChild(btn);
  }

  // Next
  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener("click", () => {
    currentPage++;
    renderCurrentPage();
  });
  paginationEl.appendChild(nextBtn);
}

function renderCurrentPage() {
  feedEl.innerHTML = "";
  const start = (currentPage - 1) * PAPERS_PER_PAGE;
  const end = start + PAPERS_PER_PAGE;
  const pagePapers = allPapers.slice(start, end);

  if (pagePapers.length === 0) {
    feedEl.innerHTML =
      '<p class="empty-feed">No papers processed yet. Click "+ Resources" to get started.</p>';
  } else {
    for (const paper of pagePapers) {
      feedEl.appendChild(renderPaperCard(paper));
    }
  }

  renderPagination();
}

// ---- Publish nanopub click handler ----
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".np-publish-btn");
  if (!btn) return;

  const trigBase64 = btn.dataset.trig;
  const id = btn.dataset.id;
  if (!trigBase64) return;

  const trig = atob(trigBase64);

  // Check the example checkbox state
  const checkbox = document.querySelector(`.np-example input[data-id="${id}"]`);
  const isExample = checkbox ? checkbox.checked : true;

  btn.disabled = true;
  btn.textContent = "publishing...";

  try {
    const response = await fetch("/.netlify/functions/publish-nanopub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trig, isExample }),
    });

    const respText = await response.text();
    let result;
    try {
      result = JSON.parse(respText);
    } catch (_) {
      throw new Error(`Server error (${response.status}): ${respText.slice(0, 200)}`);
    }

    if (result.published && result.nanopub_uri) {
      // Replace button with published link
      const actionsDiv = btn.closest(".np-actions");
      actionsDiv.innerHTML = `
        <a href="https://platform.sciencelive4all.org/np/?uri=${encodeURIComponent(result.nanopub_uri)}" target="_blank" rel="noopener" class="np-link">view on ScienceLive</a>
        <span class="np-published">published</span>
      `;
    } else {
      btn.textContent = result.message || "failed";
      btn.disabled = false;
      console.error("Publish response:", result);
    }
  } catch (err) {
    btn.textContent = "error";
    btn.disabled = false;
    console.error("Publish error:", err.message);
    alert("Publish error: " + err.message);
  }
});

// Load feed from localStorage on page load
allPapers = loadPapersLocal();
renderCurrentPage();
