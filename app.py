import os
import re
import json
import io
import time
import logging
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from google import genai as genai_client
import PyPDF2
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import nltk
from nltk.corpus import stopwords
from nltk.tokenize import word_tokenize
from dotenv import load_dotenv

# ── Setup ─────────────────────────────────────────────────────────────────────
# Load .env from the project root (works from any working directory)
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
load_dotenv(dotenv_path=os.path.normpath(_ENV_PATH))
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

nltk.download("punkt", quiet=True)
nltk.download("punkt_tab", quiet=True)
nltk.download("stopwords", quiet=True)
nltk.download("averaged_perceptron_tagger_eng", quiet=True)

# Resolve frontend directory relative to THIS file's location — works locally and on Render
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(_BASE_DIR, "..", "frontend")
FRONTEND_DIR = os.path.normpath(FRONTEND_DIR)

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app, resources={r"/api/*": {"origins": "*"}})


@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory(FRONTEND_DIR, path)

# ── Gemini Configuration ───────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
if GEMINI_API_KEY:
    gemini = genai_client.Client(api_key=GEMINI_API_KEY)
    AI_ENABLED = True
    logger.info("✅ Gemini AI enabled (google-genai SDK)")
else:
    gemini = None
    AI_ENABLED = False
    logger.warning("⚠️  GEMINI_API_KEY not set — running in NLP-only mode")


# ── Text Helpers ───────────────────────────────────────────────────────────────
def extract_text_from_pdf(file_bytes: bytes) -> str:
    try:
        reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
        return " ".join(page.extract_text() or "" for page in reader.pages).strip()
    except Exception as e:
        logger.error(f"PDF extraction error: {e}")
        return ""


def clean_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-zA-Z\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def remove_stopwords(text: str) -> str:
    stop = set(stopwords.words("english"))
    return " ".join(w for w in word_tokenize(text) if w not in stop)


def tfidf_score(resume_text: str, job_text: str) -> float:
    r = remove_stopwords(clean_text(resume_text))
    j = remove_stopwords(clean_text(job_text))
    vec = TfidfVectorizer()
    mat = vec.fit_transform([r, j])
    score = cosine_similarity(mat[0:1], mat[1:2])[0][0] * 100
    return round(score, 2)


def extract_keywords(text: str, n: int = 25) -> list:
    stop = set(stopwords.words("english"))
    words = re.findall(r"\b[a-zA-Z]{3,}\b", text.lower())
    filtered = [w for w in words if w not in stop]
    freq = {}
    for w in filtered:
        freq[w] = freq.get(w, 0) + 1
    sorted_words = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    return [w for w, _ in sorted_words[:n]]


# ── Gemini AI Analysis ─────────────────────────────────────────────────────────
ANALYSIS_PROMPT = """
You are an expert ATS (Applicant Tracking System) resume evaluator and career coach.

Analyse the RESUME against the JOB DESCRIPTION and return ONLY a valid JSON object (no markdown, no extra text).

RESUME:
{resume}

JOB DESCRIPTION:
{job_description}

Return this exact JSON structure:
{{
  "ats_score": <integer 0-100>,
  "overall_verdict": "<Excellent|Good|Fair|Poor>",
  "summary": "<2-3 sentence executive summary of the match>",
  "score_breakdown": {{
    "skills_match": <integer 0-100>,
    "experience_relevance": <integer 0-100>,
    "education_fit": <integer 0-100>,
    "keyword_density": <integer 0-100>,
    "formatting_quality": <integer 0-100>
  }},
  "matched_skills": ["<skill1>", "<skill2>"],
  "missing_skills": ["<skill1>", "<skill2>"],
  "strengths": ["<strength1>", "<strength2>", "<strength3>"],
  "improvements": ["<improvement1>", "<improvement2>", "<improvement3>"],
  "action_items": [
    {{"priority": "High|Medium|Low", "action": "<specific action to take>"}}
  ],
  "industry_keywords_found": ["<kw1>", "<kw2>"],
  "industry_keywords_missing": ["<kw1>", "<kw2>"],
  "experience_years_required": "<e.g. 3-5 years>",
  "experience_years_detected": "<e.g. ~4 years>",
  "role_fit_percentage": <integer 0-100>,
  "interview_likelihood": "<High|Medium|Low>"
}}
"""


def run_gemini_analysis(resume_text: str, job_description: str) -> dict:
    prompt = ANALYSIS_PROMPT.format(
        resume=resume_text[:8000],
        job_description=job_description[:3000],
    )
    try:
        response = gemini.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        raw = response.text.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error(f"JSON parse error: {e}")
        return {}
    except Exception as e:
        logger.error(f"Gemini API error: {e}")
        return {}


# ── NLP Fallback Analysis ─────────────────────────────────────────────────
def nlp_fallback(resume_text: str, job_description: str) -> dict:
    score = tfidf_score(resume_text, job_description)
    resume_kw = set(extract_keywords(resume_text, 30))
    job_kw = set(extract_keywords(job_description, 30))
    matched = list(resume_kw & job_kw)
    missing = list(job_kw - resume_kw)

    verdict = (
        "Excellent" if score >= 75
        else "Good" if score >= 55
        else "Fair" if score >= 35
        else "Poor"
    )

    return {
        "ats_score": int(score),
        "overall_verdict": verdict,
        "summary": (
            f"NLP analysis shows a {score:.1f}% keyword overlap between your resume "
            f"and the job description. {len(matched)} keywords matched out of {len(job_kw)} detected in the job posting."
        ),
        "score_breakdown": {
            "skills_match": int(score * 0.9),
            "experience_relevance": int(score * 0.85),
            "education_fit": int(min(score + 10, 100)),
            "keyword_density": int(score),
            "formatting_quality": 70,
        },
        "matched_skills": matched[:12],
        "missing_skills": missing[:12],
        "strengths": [
            f"Found {len(matched)} matching keywords with the job description",
            "Resume text was successfully parsed and analysed",
            "Keywords are present in a technical context",
        ],
        "improvements": [
            "Add more industry-specific keywords from the job posting",
            "Quantify achievements with numbers and metrics",
            "Mirror the exact phrasing used in the job description",
        ],
        "action_items": [
            {"priority": "High", "action": f"Add these missing keywords: {', '.join(missing[:5])}"},
            {"priority": "Medium", "action": "Tailor your summary section to match the role"},
            {"priority": "Low", "action": "Review formatting for full ATS compatibility"},
        ],
        "industry_keywords_found": matched[:8],
        "industry_keywords_missing": missing[:8],
        "experience_years_required": "Not detected",
        "experience_years_detected": "Not detected",
        "role_fit_percentage": int(score),
        "interview_likelihood": "High" if score >= 70 else "Medium" if score >= 45 else "Low",
    }


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "ai_enabled": AI_ENABLED, "version": "2.0.0"})


@app.route("/api/analyse", methods=["POST"])
def analyse():
    t0 = time.time()

    if "resume" not in request.files:
        return jsonify({"error": "No resume file uploaded"}), 400
    job_description = request.form.get("job_description", "").strip()
    if not job_description:
        return jsonify({"error": "Job description is required"}), 400

    resume_file = request.files["resume"]
    if not resume_file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400

    resume_bytes = resume_file.read()
    resume_text = extract_text_from_pdf(resume_bytes)
    if not resume_text or len(resume_text) < 50:
        return jsonify({"error": "Could not extract text from PDF. Ensure it is not scanned/image-only."}), 400

    if AI_ENABLED:
        logger.info("Running Gemini AI analysis...")
        result = run_gemini_analysis(resume_text, job_description)
        if not result:
            logger.warning("Gemini returned empty — falling back to NLP")
            result = nlp_fallback(resume_text, job_description)
            result["ai_mode"] = "nlp_fallback"
        else:
            result["ai_mode"] = "gemini"
    else:
        result = nlp_fallback(resume_text, job_description)
        result["ai_mode"] = "nlp_only"

    result["tfidf_score"] = tfidf_score(resume_text, job_description)
    result["processing_time"] = round(time.time() - t0, 2)
    result["resume_word_count"] = len(resume_text.split())

    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("DEBUG", "true").lower() == "true"
    app.run(debug=debug, host="0.0.0.0", port=port)
