/* ─────────────────────────────────────────────────
   AI Resume Analyser — 100% Client-Side App
   No backend. Calls Gemini REST API directly.
   ─────────────────────────────────────────────── */

// ── Set PDF.js worker (must be done before any PDF call) ───────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ═══════════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
const STORAGE_KEY = "resumeai_gemini_key";

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || "";
}
function saveApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key.trim());
}
function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

// Show modal if no key saved
const apiModal    = document.getElementById("apiModal");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiBtn  = document.getElementById("saveApiKey");
const toggleEye   = document.getElementById("toggleEye");
const changeKeyBtn = document.getElementById("changeKeyBtn");
const aiBadge     = document.getElementById("ai-badge");

function openModal() {
  apiKeyInput.value = getApiKey();
  apiModal.classList.add("active");
}
function closeModal() {
  apiModal.classList.remove("active");
  if (getApiKey()) aiBadge.classList.remove("hidden");
}

saveApiBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key || !key.startsWith("AIza")) {
    showToast("error", "Please enter a valid Gemini API key (starts with AIza…)");
    return;
  }
  saveApiKey(key);
  closeModal();
  showToast("success", "API key saved! You're ready to analyse.");
});

toggleEye.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleEye.textContent = isPassword ? "🙈" : "👁";
});

changeKeyBtn.addEventListener("click", openModal);

// Auto-open modal on load if no key
if (!getApiKey()) {
  openModal();
} else {
  aiBadge.classList.remove("hidden");
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM References
// ═══════════════════════════════════════════════════════════════════════════
const dropZone         = document.getElementById("dropZone");
const resumeFile       = document.getElementById("resumeFile");
const browseBtn        = document.getElementById("browseBtn");
const dropInner        = document.getElementById("dropInner");
const filePreview      = document.getElementById("filePreview");
const fileName         = document.getElementById("fileName");
const fileSize         = document.getElementById("fileSize");
const removeFile       = document.getElementById("removeFile");
const jobDesc          = document.getElementById("jobDesc");
const charCount        = document.getElementById("charCount");
const analyseBtn       = document.getElementById("analyseBtn");
const btnText          = document.getElementById("btnText");
const btnSpinner       = document.getElementById("btnSpinner");
const placeholder      = document.getElementById("placeholder");
const resultsContainer = document.getElementById("resultsContainer");
const toast            = document.getElementById("toast");
const navbar           = document.getElementById("navbar");
const downloadBtn      = document.getElementById("downloadBtn");

let currentFile  = null;
let lastResult   = null;

// ── Navbar Scroll ──────────────────────────────────────────────────────────
window.addEventListener("scroll", () => {
  navbar.classList.toggle("scrolled", window.scrollY > 40);
});

// ═══════════════════════════════════════════════════════════════════════════
// PDF TEXT EXTRACTION (runs in-browser via PDF.js)
// ═══════════════════════════════════════════════════════════════════════════
async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + " ";
  }
  return text.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI API — called directly from the browser
// ═══════════════════════════════════════════════════════════════════════════
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const ANALYSIS_PROMPT = `You are an expert ATS (Applicant Tracking System) resume evaluator and career coach.

Analyse the RESUME against the JOB DESCRIPTION and return ONLY a valid JSON object (no markdown, no extra text).

RESUME:
{resume}

JOB DESCRIPTION:
{job_description}

Return this exact JSON structure:
{
  "ats_score": <integer 0-100>,
  "overall_verdict": "<Excellent|Good|Fair|Poor>",
  "summary": "<2-3 sentence executive summary of the match>",
  "score_breakdown": {
    "skills_match": <integer 0-100>,
    "experience_relevance": <integer 0-100>,
    "education_fit": <integer 0-100>,
    "keyword_density": <integer 0-100>,
    "formatting_quality": <integer 0-100>
  },
  "matched_skills": ["<skill1>", "<skill2>"],
  "missing_skills": ["<skill1>", "<skill2>"],
  "strengths": ["<strength1>", "<strength2>", "<strength3>"],
  "improvements": ["<improvement1>", "<improvement2>", "<improvement3>"],
  "action_items": [
    {"priority": "High|Medium|Low", "action": "<specific action to take>"}
  ],
  "industry_keywords_found": ["<kw1>", "<kw2>"],
  "industry_keywords_missing": ["<kw1>", "<kw2>"],
  "experience_years_required": "<e.g. 3-5 years>",
  "experience_years_detected": "<e.g. ~4 years>",
  "role_fit_percentage": <integer 0-100>,
  "interview_likelihood": "<High|Medium|Low>"
}`;

async function callGeminiAPI(resumeText, jobDescription) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key");

  const prompt = ANALYSIS_PROMPT
    .replace("{resume}", resumeText.slice(0, 8000))
    .replace("{job_description}", jobDescription.slice(0, 3000));

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (res.status === 400 || res.status === 403) {
      showToast("error", "Invalid API key. Click 🔑 to update it.");
      openModal();
    }
    throw new Error(msg);
  }

  const data = await res.json();
  let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  raw = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
  return JSON.parse(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// NLP FALLBACK — pure JavaScript, no server needed
// ═══════════════════════════════════════════════════════════════════════════
function stopwords() {
  return new Set([
    "a","an","the","is","it","in","on","at","to","for","of","and","or","but",
    "with","as","by","from","that","this","are","was","were","be","been","has",
    "have","had","do","does","did","will","would","could","should","may","might",
    "shall","can","not","no","about","which","we","you","they","he","she","i",
    "my","your","our","their","its","so","if","then","than","more","most","some",
    "any","all","also","just","very","up","out","over","after","before","into",
    "through","during","under","between","such","other","each","both","few",
    "own","same","too","only","much","how","when","where","what","who","use",
    "used","using","work","worked","working"
  ]);
}

function tokenize(text) {
  return (text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [])
    .filter(w => !stopwords().has(w));
}

function extractKeywordsJS(text, n = 25) {
  const freq = {};
  tokenize(text).forEach(w => (freq[w] = (freq[w] || 0) + 1));
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function cosineSimilarity(text1, text2) {
  const t1 = tokenize(text1), t2 = tokenize(text2);
  const vocab = [...new Set([...t1, ...t2])];
  const f1 = {}, f2 = {};
  t1.forEach(w => (f1[w] = (f1[w] || 0) + 1));
  t2.forEach(w => (f2[w] = (f2[w] || 0) + 1));
  const v1 = vocab.map(w => (f1[w] || 0) / (t1.length || 1));
  const v2 = vocab.map(w => (f2[w] || 0) / (t2.length || 1));
  const dot = v1.reduce((s, v, i) => s + v * v2[i], 0);
  const m1  = Math.sqrt(v1.reduce((s, v) => s + v * v, 0));
  const m2  = Math.sqrt(v2.reduce((s, v) => s + v * v, 0));
  return m1 && m2 ? Math.round((dot / (m1 * m2)) * 100) : 0;
}

function nlpFallback(resumeText, jobDescription) {
  const score   = cosineSimilarity(resumeText, jobDescription);
  const rkw     = new Set(extractKeywordsJS(resumeText, 30));
  const jkw     = new Set(extractKeywordsJS(jobDescription, 30));
  const matched = [...rkw].filter(w => jkw.has(w));
  const missing = [...jkw].filter(w => !rkw.has(w));
  const verdict = score >= 75 ? "Excellent" : score >= 55 ? "Good" : score >= 35 ? "Fair" : "Poor";

  return {
    ats_score: score,
    overall_verdict: verdict,
    summary: `NLP analysis shows a ${score}% keyword overlap. ${matched.length} keywords matched out of ${jkw.size} in the job posting.`,
    score_breakdown: {
      skills_match:         Math.round(score * 0.9),
      experience_relevance: Math.round(score * 0.85),
      education_fit:        Math.min(score + 10, 100),
      keyword_density:      score,
      formatting_quality:   70,
    },
    matched_skills:             matched.slice(0, 12),
    missing_skills:             missing.slice(0, 12),
    strengths:                  [`Found ${matched.length} matching keywords`, "Resume text parsed successfully", "Keywords present in context"],
    improvements:               ["Add more industry-specific keywords", "Quantify achievements with numbers", "Mirror exact phrasing from the job description"],
    action_items:               [
      { priority: "High",   action: `Add these missing keywords: ${missing.slice(0, 5).join(", ")}` },
      { priority: "Medium", action: "Tailor your summary section to match the role" },
      { priority: "Low",    action: "Review formatting for ATS compatibility" },
    ],
    industry_keywords_found:    matched.slice(0, 8),
    industry_keywords_missing:  missing.slice(0, 8),
    experience_years_required:  "Not detected",
    experience_years_detected:  "Not detected",
    role_fit_percentage:        score,
    interview_likelihood:       score >= 70 ? "High" : score >= 45 ? "Medium" : "Low",
    ai_mode:                    "nlp_only",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════════════════
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
dropZone.addEventListener("click", e => {
  if (e.target !== removeFile && !removeFile.contains(e.target)) resumeFile.click();
});
browseBtn.addEventListener("click", e => { e.stopPropagation(); resumeFile.click(); });
resumeFile.addEventListener("change", () => { if (resumeFile.files[0]) handleFile(resumeFile.files[0]); });

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showToast("error", "Please upload a PDF file only.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("error", "File size must be under 10 MB.");
    return;
  }
  currentFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  dropInner.classList.add("hidden");
  filePreview.classList.remove("hidden");
  updateBtn();
  showToast("success", "Resume uploaded!");
}

removeFile.addEventListener("click", e => {
  e.stopPropagation();
  currentFile = null;
  resumeFile.value = "";
  filePreview.classList.add("hidden");
  dropInner.classList.remove("hidden");
  updateBtn();
});

jobDesc.addEventListener("input", () => {
  charCount.textContent = jobDesc.value.length.toLocaleString();
  updateBtn();
});

function updateBtn() {
  analyseBtn.disabled = !(currentFile && jobDesc.value.trim().length > 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════
analyseBtn.addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (!currentFile || jobDesc.value.trim().length < 50) return;
  if (!getApiKey()) { openModal(); return; }

  setLoading(true);
  showToast("info", "Extracting PDF text…");
  const t0 = Date.now();

  try {
    // Step 1 — Extract PDF text in browser
    const resumeText = await extractTextFromPDF(currentFile);
    if (!resumeText || resumeText.length < 50) {
      showToast("error", "Could not extract text. Use a text-based PDF (not a scanned image).");
      setLoading(false);
      return;
    }

    showToast("info", "Calling Gemini AI… (~10-20s)");

    // Step 2 — Try Gemini AI
    let result;
    try {
      result = await callGeminiAPI(resumeText, jobDesc.value.trim());
      result.ai_mode = "gemini";
    } catch (aiErr) {
      console.warn("Gemini failed, using NLP fallback:", aiErr.message);
      showToast("info", "AI unavailable — using NLP analysis…");
      result = nlpFallback(resumeText, jobDesc.value.trim());
    }

    result.processing_time = ((Date.now() - t0) / 1000).toFixed(1);
    result.resume_word_count = resumeText.split(/\s+/).length;
    result.tfidf_score = cosineSimilarity(resumeText, jobDesc.value.trim());

    lastResult = result;
    renderResults(result);
    showToast("success", "Analysis complete!");
    document.getElementById("resultsPanel").scrollIntoView({ behavior: "smooth" });

  } catch (err) {
    showToast("error", "Something went wrong: " + err.message);
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER RESULTS
// ═══════════════════════════════════════════════════════════════════════════
function renderResults(d) {
  placeholder.classList.add("hidden");
  resultsContainer.classList.remove("hidden");

  const score = d.ats_score ?? 0;
  animateGauge(score);
  document.getElementById("gaugeScore").textContent = score + "%";

  const vb = document.getElementById("verdictBadge");
  vb.textContent = d.overall_verdict ?? "—";
  vb.className = `verdict-badge verdict-${d.overall_verdict}`;

  document.getElementById("scoreMode").textContent =
    `Mode: ${d.ai_mode === "gemini" ? "🤖 Gemini AI" : d.ai_mode === "nlp_fallback" ? "⚡ NLP Fallback" : "📊 NLP Only"}`;
  document.getElementById("scoreSummary").textContent      = d.summary ?? "—";
  document.getElementById("metaTime").textContent          = `⏱ ${d.processing_time}s`;
  document.getElementById("metaWords").textContent         = `📝 ${d.resume_word_count} words`;
  document.getElementById("metaLikelihood").textContent    = `🎯 ${d.interview_likelihood ?? "—"} likelihood`;

  // Breakdown bars
  const breakdownMeta = [
    { key: "skills_match",         label: "Skills Match" },
    { key: "experience_relevance", label: "Experience Relevance" },
    { key: "education_fit",        label: "Education Fit" },
    { key: "keyword_density",      label: "Keyword Density" },
    { key: "formatting_quality",   label: "Formatting Quality" },
  ];
  const bl = document.getElementById("breakdownList");
  bl.innerHTML = "";
  (breakdownMeta).forEach(({ key, label }) => {
    const val = d.score_breakdown?.[key] ?? 0;
    bl.innerHTML += `
      <div class="breakdown-item">
        <div class="breakdown-header"><span>${label}</span><span>${val}%</span></div>
        <div class="breakdown-bar-bg">
          <div class="breakdown-bar-fill" data-width="${val}"></div>
        </div>
      </div>`;
  });
  setTimeout(() => {
    document.querySelectorAll(".breakdown-bar-fill").forEach(bar => {
      bar.style.width = bar.dataset.width + "%";
    });
  }, 100);

  renderTags("matchedSkills", d.matched_skills, "matched");
  renderTags("missingSkills", d.missing_skills, "missing");
  renderTags("kwFound",   d.industry_keywords_found,  "keyword");
  renderTags("kwMissing", d.industry_keywords_missing, "kw-missing");
  renderList("strengthsList",    d.strengths);
  renderList("improvementsList", d.improvements);

  const al = document.getElementById("actionList");
  al.innerHTML = "";
  (d.action_items ?? []).forEach(item => {
    al.innerHTML += `
      <div class="action-item">
        <span class="priority-badge priority-${item.priority}">${item.priority}</span>
        <span class="action-text">${item.action}</span>
      </div>`;
  });

  document.getElementById("expRequired").textContent        = d.experience_years_required ?? "—";
  document.getElementById("expDetected").textContent        = d.experience_years_detected  ?? "—";
  document.getElementById("roleFit").textContent            = (d.role_fit_percentage ?? "—") + "%";
  document.getElementById("interviewLikelihood").textContent = d.interview_likelihood ?? "—";
}

function renderTags(id, arr, type) {
  const el = document.getElementById(id);
  if (!arr?.length) { el.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem">None detected</span>'; return; }
  el.innerHTML = arr.map(s => `<span class="skill-tag ${type === "missing" ? "missing" : ""}">${s}</span>`).join("");
}

function renderList(id, arr) {
  const el = document.getElementById(id);
  if (!arr?.length) { el.innerHTML = "<li>None detected</li>"; return; }
  el.innerHTML = arr.map(s => `<li>${s}</li>`).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// GAUGE ANIMATION
// ═══════════════════════════════════════════════════════════════════════════
function animateGauge(score) {
  const arc = document.getElementById("gaugeArc");
  const grad = document.getElementById("gaugeGrad");
  const totalLength = 251.2;
  const offset = totalLength - (totalLength * score / 100);

  if (score >= 75) {
    grad.children[0].style.stopColor = "#10b981";
    grad.children[1].style.stopColor = "#06b6d4";
  } else if (score >= 50) {
    grad.children[0].style.stopColor = "#7c3aed";
    grad.children[1].style.stopColor = "#06b6d4";
  } else if (score >= 30) {
    grad.children[0].style.stopColor = "#f59e0b";
    grad.children[1].style.stopColor = "#ec4899";
  } else {
    grad.children[0].style.stopColor = "#ef4444";
    grad.children[1].style.stopColor = "#f59e0b";
  }
  setTimeout(() => { arc.style.strokeDashoffset = offset; }, 100);

  let current = 0;
  const step = score / 60;
  const scoreEl = document.getElementById("gaugeScore");
  const interval = setInterval(() => {
    current = Math.min(current + step, score);
    scoreEl.textContent = Math.round(current) + "%";
    if (current >= score) clearInterval(interval);
  }, 25);
}

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD REPORT
// ═══════════════════════════════════════════════════════════════════════════
downloadBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const d = lastResult;
  const sep = "─".repeat(60);
  const lines = [
    "=".repeat(60),
    "         AI RESUME ANALYSER — FULL REPORT",
    "=".repeat(60),
    "",
    `ATS Score         : ${d.ats_score}%`,
    `Overall Verdict   : ${d.overall_verdict}`,
    `Interview Chance  : ${d.interview_likelihood}`,
    `Role Fit          : ${d.role_fit_percentage}%`,
    `Analysis Mode     : ${d.ai_mode}`,
    `Processing Time   : ${d.processing_time}s`,
    `Resume Word Count : ${d.resume_word_count}`,
    "", sep, "SUMMARY", sep,
    d.summary,
    "", sep, "SCORE BREAKDOWN", sep,
    ...Object.entries(d.score_breakdown ?? {}).map(([k, v]) => `  ${k.replace(/_/g," ").padEnd(25)}: ${v}%`),
    "", sep, "MATCHED SKILLS", sep,
    (d.matched_skills ?? []).join(", ") || "None",
    "", sep, "MISSING SKILLS", sep,
    (d.missing_skills ?? []).join(", ") || "None",
    "", sep, "STRENGTHS", sep,
    ...(d.strengths ?? []).map((s, i) => `  ${i+1}. ${s}`),
    "", sep, "IMPROVEMENTS", sep,
    ...(d.improvements ?? []).map((s, i) => `  ${i+1}. ${s}`),
    "", sep, "ACTION PLAN", sep,
    ...(d.action_items ?? []).map(a => `  [${a.priority}] ${a.action}`),
    "", sep, "KEYWORDS FOUND", sep,
    (d.industry_keywords_found ?? []).join(", ") || "None",
    "", sep, "KEYWORDS MISSING", sep,
    (d.industry_keywords_missing ?? []).join(", ") || "None",
    "", sep, "EXPERIENCE", sep,
    `  Required : ${d.experience_years_required}`,
    `  Detected : ${d.experience_years_detected}`,
    "",
    "=".repeat(60),
    `Report generated: ${new Date().toLocaleString()} | ResumeAI`,
    "=".repeat(60),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ResumeAI_Report_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("success", "Report downloaded!");
});

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function setLoading(on) {
  analyseBtn.disabled = on;
  btnText.textContent = on ? "Analysing…" : "Analyse My Resume";
  btnSpinner.classList.toggle("hidden", !on);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function showToast(type, message) {
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 4500);
}
