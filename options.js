const extension = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const msg = (text, cls = "") => { $("msg").textContent = text; $("msg").className = cls; };

async function load() {
  const s = await extension.storage.sync.get(["apiKey", "rubricsJson", "autoAnalyze", "debounceMs", "openaiKey", "visionModel", "describeMedia"]);
  $("apiKey").value = s.apiKey || "";
  $("openaiKey").value = s.openaiKey || "";
  $("visionModel").value = s.visionModel || "gpt-4o-mini";
  $("describeMedia").checked = s.describeMedia !== false;
  $("autoAnalyze").checked = s.autoAnalyze !== false;
  $("debounceMs").value = s.debounceMs || 1200;
  $("rubrics").value = s.rubricsJson || JSON.stringify(VIBECHECK_DEFAULT_RUBRICS, null, 2);
}

function validateRubrics(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || !arr.length) throw new Error("Rubrics must be a non-empty array");
  const ids = new Set();
  for (const r of arr) {
    if (!r.id || typeof r.id !== "string") throw new Error("Every rubric needs a string id");
    if (ids.has(r.id)) throw new Error(`Duplicate id: ${r.id}`);
    ids.add(r.id);
    if (!["score", "noul", "choice"].includes(r.type)) throw new Error(`${r.id}: type must be score, noul or choice`);
    if (!r.instructions) throw new Error(`${r.id}: instructions required`);
    if (r.type === "score" && (!Array.isArray(r.criteria) || r.criteria.length < 2 || r.criteria.length > 10))
      throw new Error(`${r.id}: score criteria must be an array of 2–10 levels`);
    if (r.type === "choice" && (typeof r.criteria !== "object" || Object.keys(r.criteria).length < 2))
      throw new Error(`${r.id}: choice criteria must be an object with 2+ options`);
    if (r.requires && r.requires !== "media") throw new Error(`${r.id}: requires must be "media" or omitted`);
  }
  return arr;
}

$("save").addEventListener("click", async () => {
  try {
    const rubrics = validateRubrics($("rubrics").value);
    const isDefault = JSON.stringify(rubrics) === JSON.stringify(VIBECHECK_DEFAULT_RUBRICS);
    await extension.storage.sync.set({
      apiKey: $("apiKey").value.trim(),
      openaiKey: $("openaiKey").value.trim(),
      visionModel: $("visionModel").value.trim() || "gpt-4o-mini",
      describeMedia: $("describeMedia").checked,
      autoAnalyze: $("autoAnalyze").checked,
      debounceMs: Math.max(300, Number($("debounceMs").value) || 1200),
      rubricsJson: isDefault ? "" : JSON.stringify(rubrics),
    });
    msg("Saved.", "ok");
  } catch (e) {
    msg(`Not saved: ${e.message}`, "err");
  }
});

$("reset").addEventListener("click", () => {
  $("rubrics").value = JSON.stringify(VIBECHECK_DEFAULT_RUBRICS, null, 2);
  msg("Defaults restored (click Save to apply).");
});

$("reveal").addEventListener("click", () => {
  const i = $("apiKey");
  i.type = i.type === "password" ? "text" : "password";
  $("reveal").textContent = i.type === "password" ? "Show" : "Hide";
});

$("revealOpenai").addEventListener("click", () => {
  const i = $("openaiKey");
  i.type = i.type === "password" ? "text" : "password";
  $("revealOpenai").textContent = i.type === "password" ? "Show" : "Hide";
});

$("testOpenai").addEventListener("click", async () => {
  const key = $("openaiKey").value.trim();
  const model = $("visionModel").value.trim() || "gpt-4o-mini";
  if (!key) return msg("Enter an OpenAI key first.", "err");
  msg("Testing…");
  try {
    const res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) msg(`OpenAI key works and model "${model}" is available.`, "ok");
    else if (res.status === 404) msg(`Key works but model "${model}" was not found on your account.`, "err");
    else msg(`OpenAI rejected the key: HTTP ${res.status}`, "err");
  } catch (e) {
    msg(`Request failed: ${e.message}`, "err");
  }
});

$("test").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return msg("Enter a key first.", "err");
  msg("Testing…");
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "ship it",
        model: "jev-latest",
        questions: { ok: { type: "noul", instructions: "Is this text in English?" } },
      }),
    });
    if (res.ok) {
      const j = await res.json();
      msg(`Key works (model ${j.model}, ${j.usage?.input_tokens} tokens).`, "ok");
    } else {
      msg(`Key rejected: HTTP ${res.status}`, "err");
    }
  } catch (e) {
    msg(`Request failed: ${e.message}`, "err");
  }
});

load();
