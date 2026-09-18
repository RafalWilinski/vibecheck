// Background: holds the API keys and calls TypeSafe / OpenAI from here so the
// keys never touch the x.com page context and CORS is a non-issue.

// Firefox loads rubrics through background.scripts instead of a service worker.
if (typeof importScripts === "function") importScripts("rubrics.js");

const extension = globalThis.browser ?? globalThis.chrome;

const TS_URL = "https://api.typesafe.ai/v1/systemone";
const TS_MODEL = "jev-latest";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_VISION_MODEL = "gpt-4o-mini";

const VISION_PROMPT = `You are describing media attached to a social media post for a text-only judge that will rate the post (virality, humor, offensiveness, regret risk). The judge cannot see the media, so be concrete and neutral.
Cover, in under 130 words:
- What is depicted (subjects, setting, action). If it is a recognizable meme format or screenshot, name it.
- Any visible text, transcribed verbatim.
- Tone/mood and apparent intent (joke, proof, reaction image, selfie, product shot...).
- Anything sensitive: NSFW, gore, identifiable private people, personal data (addresses, plates, private messages), watermarks or copyright, political symbols.
Do not speculate about the caption or evaluate the post; only describe the media.`;

extension.action.onClicked.addListener(() => extension.runtime.openOptionsPage());
extension.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") extension.runtime.openOptionsPage();
});

extension.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "vibecheck:analyze":
      analyze(msg.state)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "vibecheck:describe":
      describe(msg)
        .then((description) => sendResponse({ ok: true, description }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "vibecheck:getSettings":
      getSettings().then((s) => sendResponse({ ok: true, settings: { describeMedia: s.describeMedia, hasOpenAI: !!s.openaiKey } }));
      return true;
    case "vibecheck:openOptions":
      extension.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
  }
  return false;
});

async function getSettings() {
  const s = await extension.storage.sync.get([
    "apiKey", "rubricsJson", "autoAnalyze", "debounceMs", "openaiKey", "visionModel", "describeMedia",
  ]);
  return {
    apiKey: s.apiKey || "",
    rubricsJson: s.rubricsJson || "",
    autoAnalyze: s.autoAnalyze !== false,
    debounceMs: Number(s.debounceMs) || 1200,
    openaiKey: s.openaiKey || "",
    visionModel: (s.visionModel || DEFAULT_VISION_MODEL).trim(),
    describeMedia: s.describeMedia !== false,
  };
}

async function getRubrics() {
  const { rubricsJson } = await getSettings();
  if (rubricsJson) {
    try {
      const parsed = JSON.parse(rubricsJson);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) { /* fall back to defaults */ }
  }
  return VIBECHECK_DEFAULT_RUBRICS;
}

function applicableRubrics(rubrics, state) {
  const hasMedia = Array.isArray(state?.media) && state.media.length > 0;
  return rubrics.filter((r) => !r.requires || (r.requires === "media" && hasMedia));
}

function toQuestions(rubrics) {
  const questions = {};
  for (const r of rubrics) {
    const q = { type: r.type, instructions: r.instructions };
    if (r.criteria !== undefined) q.criteria = r.criteria;
    questions[r.id] = q;
  }
  return questions;
}

async function fetchWithBackoff(url, init, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new Error(`${label}: invalid API key (401). Check it in Vibe Check settings.`);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new Error(`${label}: request rejected (${res.status}): ${text.slice(0, 300)}`);
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt;
      lastErr = new Error(`${label}: ${res.status === 429 ? "rate limited (429)" : `server error (${res.status})`}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  throw lastErr || new Error(`${label}: failed after retries`);
}

async function analyze(state) {
  const { apiKey } = await getSettings();
  if (!apiKey) throw new Error("NO_API_KEY");
  const rubrics = applicableRubrics(await getRubrics(), state);
  const res = await fetchWithBackoff(
    TS_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: TS_MODEL, questions: toQuestions(rubrics) }),
    },
    "TypeSafe"
  );
  const json = await res.json();
  return { answers: json.answers, usage: json.usage, model: json.model, rubrics };
}

// msg: { kind: "image"|"video", dataUrl?: string, url?: string }
async function describe({ kind, dataUrl, url }) {
  const { openaiKey, visionModel, describeMedia } = await getSettings();
  if (!describeMedia) throw new Error("MEDIA_DISABLED");
  if (!openaiKey) throw new Error("NO_OPENAI_KEY");
  const imageUrl = dataUrl || url;
  if (!imageUrl) throw new Error("No image data");

  const body = {
    model: visionModel,
    max_completion_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT + (kind === "video" ? "\n\nThis is a single frame captured from a video or GIF." : "") },
          { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
        ],
      },
    ],
  };
  const res = await fetchWithBackoff(
    OPENAI_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "OpenAI"
  );
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI: empty response");
  return String(text).trim();
}
