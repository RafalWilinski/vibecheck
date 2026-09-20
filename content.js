// Content script: watches X's composer, extracts the draft, asks the background
// worker to run it through Jev, and renders a scorecard under the composer.
(() => {
  if (window.__vibecheckLoaded) return;
  window.__vibecheckLoaded = true;

  const extension = globalThis.browser ?? globalThis.chrome;
  const PANEL_ID = "vibecheck-panel";
  // Note: X also has data-testid="tweetTextarea_0_label" (the placeholder) and
  // "...RichTextInputContainer" (a wrapper); only accept real role=textbox nodes.
  const TEXTBOX_SEL = '[data-testid^="tweetTextarea_"][role="textbox"], [data-testid^="tweetTextarea_"]:not([data-testid$="_label"]) [role="textbox"]';
  const TOOLBAR_SEL = '[data-testid="toolBar"]';
  const POST_BTN_SEL = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
  const REPLY_CTX_SEL = '[data-testid="tweetText"]';
  const ATTACH_SEL = '[data-testid="attachments"]';
  const REPLY_PHOTO_SEL = '[data-testid="tweetPhoto"] img';
  const MIN_CHARS = 6;
  const MAX_IMAGE_EDGE = 1024;

  // src -> Promise<{description} | {error}>; blob: URLs are unique per attachment,
  // so this caches vision calls across keystrokes and re-renders.
  const mediaCache = new Map();
  let lastMediaSig = "";

  let settings = { autoAnalyze: true, debounceMs: 1200, describeMedia: true };
  let debounceTimer = null;
  let lastAnalyzedKey = "";
  let inFlight = false;
  let currentHost = null; // the composer root we attached to

  extension.storage.sync.get(["autoAnalyze", "debounceMs", "describeMedia"]).then((s) => {
    if (typeof s.autoAnalyze === "boolean") settings.autoAnalyze = s.autoAnalyze;
    if (Number(s.debounceMs) > 0) settings.debounceMs = Number(s.debounceMs);
    if (typeof s.describeMedia === "boolean") settings.describeMedia = s.describeMedia;
  });
  extension.storage.onChanged.addListener((changes) => {
    if (changes.autoAnalyze) settings.autoAnalyze = changes.autoAnalyze.newValue;
    if (changes.debounceMs) settings.debounceMs = Number(changes.debounceMs.newValue) || 1200;
    if (changes.describeMedia) settings.describeMedia = changes.describeMedia.newValue;
    if (changes.openaiKey || changes.visionModel) mediaCache.clear();
  });

  // ---------- composer discovery ----------

  function findTextboxes() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(TEXTBOX_SEL)) {
      const tb = el.getAttribute("role") === "textbox" ? el : el.querySelector('[role="textbox"]');
      if (!tb || seen.has(tb)) continue;
      seen.add(tb);
      out.push(tb);
    }
    return out;
  }

  // The composer "host" is the element we hang the panel off: the toolbar row
  // (which holds media/emoji buttons + Post) if we can find it, else the textbox.
  function findComposerHost(textbox) {
    const dialog = textbox.closest('[role="dialog"]');
    const scope = dialog || document;
    const toolbars = [...scope.querySelectorAll(TOOLBAR_SEL)];
    // Pick the toolbar closest *after* the textbox in DOM order.
    const after = toolbars.find((tb) => textbox.compareDocumentPosition(tb) & Node.DOCUMENT_POSITION_FOLLOWING);
    return after || textbox;
  }

  function getDraftParts() {
    return findTextboxes()
      .map((tb) => (tb.innerText || tb.textContent || "").replace(/ /g, " ").trim())
      .filter(Boolean);
  }

  function tweetInfo(container) {
    const text = container?.querySelector(REPLY_CTX_SEL)?.innerText?.trim();
    if (!text) return null;
    const author = container.querySelector('[data-testid="User-Name"]')?.innerText?.split("\n")[0];
    return { author, text };
  }

  // Returns { reply_to?, quoting? }. In X's compose modal the tweet being replied
  // to is rendered ABOVE the textbox and a quoted tweet is rendered BELOW it, so
  // DOM order tells them apart. On a status page the inline reply composer sits
  // under the main tweet article.
  function getContextTweets(textbox) {
    const out = {};
    const dialog = textbox.closest('[role="dialog"]');
    if (!dialog) {
      if (/\/status\/\d+/.test(location.pathname)) {
        const info = tweetInfo(document.querySelector('article[data-testid="tweet"]'));
        if (info) out.reply_to = info;
      }
      return out;
    }
    for (const t of dialog.querySelectorAll(REPLY_CTX_SEL)) {
      if (t.closest(ATTACH_SEL)) continue;
      const before = textbox.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING;
      const key = before ? "reply_to" : "quoting";
      if (out[key]) continue; // first match per side wins; nested quote-in-reply is ignored
      const container = t.closest('article') || t.closest('[role="link"]') || t.parentElement;
      const info = tweetInfo(container) || { text: t.innerText.trim() };
      out[key] = info;
    }
    return out;
  }

  // ---------- media ----------

  function collectMedia(textbox) {
    const dialog = textbox.closest('[role="dialog"]');
    const scope = dialog || document;
    const items = [];
    const seen = new Set();
    const push = (el, kind, src, role) => {
      if (!src || seen.has(src)) return;
      seen.add(src);
      items.push({ el, kind, src, role });
    };
    for (const root of scope.querySelectorAll(ATTACH_SEL)) {
      for (const img of root.querySelectorAll("img")) push(img, "image", img.currentSrc || img.src, "draft");
      for (const v of root.querySelectorAll("video")) push(v, "video", v.currentSrc || v.src || v.querySelector("source")?.src, "draft");
    }
    if (dialog) {
      for (const img of dialog.querySelectorAll(REPLY_PHOTO_SEL)) {
        if (img.closest(ATTACH_SEL)) continue;
        const before = textbox.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_PRECEDING;
        push(img, "image", img.currentSrc || img.src, before ? "reply_to" : "quoting");
      }
    }
    return items;
  }

  function mediaSignature(textbox) {
    return collectMedia(textbox).map((m) => m.src).join("|");
  }

  function downscale(source, w, h) {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext("2d").drawImage(source, 0, 0, cw, ch);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function imageToDataUrl(src) {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    try {
      return downscale(bmp, bmp.width, bmp.height);
    } finally {
      bmp.close?.();
    }
  }

  async function videoFrameToDataUrl(video) {
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener("loadeddata", done); resolve(); };
        video.addEventListener("loadeddata", done);
        setTimeout(done, 2500);
      });
    }
    if (video.readyState < 2 || !video.videoWidth) throw new Error("Video frame not available");
    return downscale(video, video.videoWidth, video.videoHeight);
  }

  async function describeOne(item) {
    const payload = { type: "vibecheck:describe", kind: item.kind };
    if (/^https?:/i.test(item.src)) {
      payload.url = item.src; // OpenAI fetches public pbs.twimg.com URLs itself
    } else {
      payload.dataUrl = item.kind === "video" ? await videoFrameToDataUrl(item.el) : await imageToDataUrl(item.src);
    }
    const res = await extension.runtime.sendMessage(payload);
    if (!res?.ok) throw new Error(res?.error || "describe failed");
    return { description: res.description };
  }

  async function describeMedia(items) {
    return Promise.all(
      items.map(async (item) => {
        if (!mediaCache.has(item.src)) {
          mediaCache.set(
            item.src,
            describeOne(item).catch((e) => {
              mediaCache.delete(item.src); // don't cache failures (e.g. missing key)
              return { error: String(e?.message || e) };
            })
          );
        }
        const r = await mediaCache.get(item.src);
        return { kind: item.kind, role: item.role, ...r };
      })
    );
  }

  function mediaError(err) {
    if (err === "NO_OPENAI_KEY") return "attached, but not described: add an OpenAI key in settings";
    if (err === "MEDIA_DISABLED") return "attached, but media description is turned off";
    return `attached, but could not be described (${err})`;
  }

  async function buildState(textbox) {
    const parts = getDraftParts();
    const state = {};
    if (parts.length > 1) {
      state.draft = parts.map((text, i) => ({ part: i + 1, text }));
      state.note = "`draft` is a multi-post thread; judge it as a whole.";
    } else {
      state.draft = parts[0] || "";
    }
    const ctx = getContextTweets(textbox);
    const notes = [];
    if (state.note) notes.push(state.note);
    if (ctx.reply_to) {
      state.reply_to = ctx.reply_to;
      notes.push("`draft` is a reply to `reply_to`.");
    }
    if (ctx.quoting) {
      state.quoting = ctx.quoting;
      notes.push("`draft` is a quote post: it will be shown on top of `quoting`, so readers see both together.");
    }
    if (notes.length) state.note = notes.join(" ");

    const items = collectMedia(textbox);
    if (items.length) {
      setStatus("describing media…", "vc-busy");
      const described = settings.describeMedia
        ? await describeMedia(items)
        : items.map((i) => ({ kind: i.kind, role: i.role, error: "MEDIA_DISABLED" }));
      const byRole = { draft: [], reply_to: [], quoting: [] };
      described.forEach((d, i) => {
        byRole[d.role || "draft"].push({
          index: i + 1,
          kind: d.kind === "video" ? "video/GIF (first frame described)" : "image",
          description: d.description || mediaError(d.error),
        });
      });
      if (byRole.draft.length) state.media = byRole.draft;
      if (byRole.reply_to.length && state.reply_to) state.reply_to.media = byRole.reply_to;
      if (byRole.quoting.length && state.quoting) state.quoting.media = byRole.quoting;
      state.note =
        (state.note ? state.note + " " : "") +
        "`media` entries are text descriptions of attached images/videos written by a vision model; the judge cannot see the media itself and should reason from the descriptions.";
    }
    return state;
  }

  // ---------- panel ----------

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) n.append(c);
    return n;
  }

  function themeClass() {
    const bg = getComputedStyle(document.body).backgroundColor || "";
    const m = bg.match(/\d+/g);
    if (!m) return "vc-dark";
    const [r, g, b] = m.map(Number);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > 180) return "vc-light";
    if (lum > 40) return "vc-dim";
    return "vc-dark";
  }

  function ensurePanel(host) {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.isConnected && currentHost === host && host.isConnected) return panel;
    if (panel) panel.remove();

    panel = el("div", { id: PANEL_ID, class: `vc ${themeClass()}` });
    const header = el("div", { class: "vc-header" }, [
      el("span", { class: "vc-title", text: "Vibe check" }),
      el("span", { class: "vc-sub", text: "by Jev" }),
      el("span", { class: "vc-status", "data-role": "status", text: "" }),
      el("button", { class: "vc-btn", type: "button", "data-role": "run", text: "Check", onclick: () => runAnalysis(true) }),
      el("button", { class: "vc-icon", type: "button", title: "Settings", text: "⚙", onclick: () => extension.runtime.sendMessage({ type: "vibecheck:openOptions" }) }),
      el("button", { class: "vc-icon", type: "button", title: "Collapse", "data-role": "toggle", text: "▾", onclick: togglePanel }),
    ]);
    panel.append(header, el("div", { class: "vc-body", "data-role": "body" }));

    // Insert right after the toolbar row (or after the textbox's block).
    const anchor = host.matches(TOOLBAR_SEL) ? host.parentElement || host : host;
    anchor.insertAdjacentElement("afterend", panel);
    currentHost = host;
    if (localStorage.getItem("vibecheck:collapsed") === "1") panel.classList.add("vc-collapsed");
    return panel;
  }

  function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle("vc-collapsed");
    localStorage.setItem("vibecheck:collapsed", panel.classList.contains("vc-collapsed") ? "1" : "0");
  }

  function setStatus(text, kind = "") {
    const panel = document.getElementById(PANEL_ID);
    const s = panel?.querySelector('[data-role="status"]');
    if (!s) return;
    s.textContent = text;
    s.className = `vc-status ${kind}`;
  }

  function renderEmpty(msg) {
    const body = document.getElementById(PANEL_ID)?.querySelector('[data-role="body"]');
    if (body) body.replaceChildren(el("div", { class: "vc-empty", text: msg }));
  }

  // ---------- scoring / rendering ----------

  function normalize(rubric, answer) {
    if (!answer) return null;
    if (answer.type === "score") {
      const levels = Array.isArray(rubric.criteria) ? rubric.criteria.length : Object.keys(answer.legend || {}).length;
      return levels > 1 ? answer.score / (levels - 1) : 0;
    }
    if (answer.type === "noul") return answer.noul;
    return null;
  }

  function levelLabel(rubric, answer) {
    if (answer.type === "score") {
      const idx = Math.round(answer.score);
      const lbl = answer.legend?.[String(idx)] ?? rubric.criteria?.[idx];
      return typeof lbl === "string" ? lbl : (lbl?.description || lbl?.name || "");
    }
    if (answer.type === "noul") {
      const yes = answer.noul >= 0.5;
      const c = rubric.criteria || {};
      return yes ? c.true || "yes" : c.false || "no";
    }
    if (answer.type === "choice") {
      const c = rubric.criteria || {};
      const d = c[answer.choice];
      return d ? `${answer.choice}: ${d}` : answer.choice;
    }
    return "";
  }

  function barColorClass(rubric, v) {
    if (rubric.polarity === "good") return v >= 0.66 ? "vc-good" : v >= 0.33 ? "vc-mid" : "vc-low";
    if (rubric.polarity === "bad") return v >= 0.66 ? "vc-bad" : v >= 0.33 ? "vc-mid" : "vc-good";
    return "vc-neutral";
  }

  function verdict(rubrics, answers) {
    let good = 0, goodW = 0, bad = 0, badW = 0, maxBad = 0;
    for (const r of rubrics) {
      const v = normalize(r, answers[r.id]);
      if (v == null || !r.weight) continue;
      if (r.polarity === "good") { good += v * r.weight; goodW += r.weight; }
      if (r.polarity === "bad") { bad += v * r.weight; badW += r.weight; maxBad = Math.max(maxBad, v); }
    }
    const g = goodW ? good / goodW : 0;
    const b = badW ? bad / badW : 0;
    const score = Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * g - 0.7 * b)) * 100);
    let label, cls;
    if (maxBad >= 0.75) { label = "Sleep on it"; cls = "vc-v-bad"; }
    else if (score >= 70) { label = "Send it"; cls = "vc-v-good"; }
    else if (score >= 45) { label = "Fine, mid"; cls = "vc-v-mid"; }
    else { label = "Probably don't"; cls = "vc-v-bad"; }
    return { score, label, cls };
  }

  function renderMedia(state) {
    const all = [
      ...(state.media || []),
      ...((state.reply_to?.media || []).map((m) => ({ ...m, role: "reply_to" }))),
      ...((state.quoting?.media || []).map((m) => ({ ...m, role: "quoting" }))),
    ];
    if (!all.length) return null;
    const details = el("details", { class: "vc-media" }, [
      el("summary", { text: `What Jev was told about ${all.length} attached ${all.length === 1 ? "item" : "items"}` }),
    ]);
    for (const m of all) {
      details.append(
        el("div", { class: "vc-media-item" }, [
          el("div", { class: "vc-media-kind", text: `${m.role ? m.role + " " : ""}${m.kind} #${m.index}` }),
          el("div", { class: "vc-media-desc", text: m.description }),
        ])
      );
    }
    return details;
  }

  function render(rubrics, answers, usage, state) {
    const panel = document.getElementById(PANEL_ID);
    const body = panel?.querySelector('[data-role="body"]');
    if (!body) return;

    const v = verdict(rubrics, answers);
    const frag = document.createDocumentFragment();

    const reaction = rubrics.find((r) => r.type === "choice" && answers[r.id]);
    frag.append(
      el("div", { class: `vc-verdict ${v.cls}` }, [
        el("div", { class: "vc-verdict-score", text: String(v.score) }),
        el("div", { class: "vc-verdict-text" }, [
          el("div", { class: "vc-verdict-label", text: v.label }),
          reaction
            ? el("div", { class: "vc-verdict-sub", text: `Likely reaction: ${levelLabel(reaction, answers[reaction.id])}` })
            : el("div", { class: "vc-verdict-sub", text: "" }),
        ]),
      ])
    );

    const grid = el("div", { class: "vc-grid" });
    for (const r of rubrics) {
      const a = answers[r.id];
      if (!a || r.type === "choice") continue;
      const val = normalize(r, a);
      const pct = Math.round(val * 100);
      const row = el("div", { class: "vc-row", title: `${r.instructions}\n\n→ ${levelLabel(r, a)}` }, [
        el("div", { class: "vc-row-top" }, [
          el("span", { class: "vc-label", text: r.label }),
          el("span", { class: "vc-val", text: r.type === "noul" ? `${pct}%` : `${a.score.toFixed(1)} / ${r.criteria.length - 1}` }),
        ]),
        el("div", { class: "vc-track" }, [el("div", { class: `vc-fill ${barColorClass(r, val)}`, style: `width:${pct}%` })]),
        el("div", { class: "vc-level", text: levelLabel(r, a) }),
      ]);
      grid.append(row);
    }
    frag.append(grid);

    if (reaction) {
      const probs = Object.entries(answers[reaction.id].probabilities || {}).sort((x, y) => y[1] - x[1]);
      frag.append(
        el("div", { class: "vc-reactions" }, probs.map(([k, p]) =>
          el("span", { class: `vc-chip ${k === answers[reaction.id].choice ? "vc-chip-top" : ""}`, title: reaction.criteria?.[k] || k, text: `${k} ${Math.round(p * 100)}%` })
        ))
      );
    }

    const media = renderMedia(state);
    if (media) frag.append(media);

    if (usage) frag.append(el("div", { class: "vc-foot", text: `${usage.input_tokens} tokens · jev` }));
    body.replaceChildren(frag);
  }

  // ---------- analysis loop ----------

  async function runAnalysis(force = false) {
    const tbs = findTextboxes();
    if (!tbs.length) return;
    const textbox = tbs.find((t) => t.contains(document.activeElement)) || tbs[0];
    const host = findComposerHost(textbox);
    ensurePanel(host);

    if (inFlight) { pendingKey = "pending"; return; }
    inFlight = true;
    try {
      const state = await buildState(textbox);
      const draftText = typeof state.draft === "string" ? state.draft : state.draft.map((p) => p.text).join("\n\n");
      const hasMedia = Array.isArray(state.media) && state.media.length > 0;
      if (draftText.length < MIN_CHARS && !hasMedia && !state.quoting) {
        renderEmpty("Start typing (or attach media) and I'll vibe check it.");
        setStatus("");
        return;
      }
      if (!draftText) state.draft = state.quoting ? "(no comment; bare quote post)" : "(no text; media only)";
      const key = JSON.stringify(state);
      if (!force && key === lastAnalyzedKey) { setStatus(""); return; }

      setStatus("thinking…", "vc-busy");
      const res = await extension.runtime.sendMessage({ type: "vibecheck:analyze", state });
      if (!res?.ok) {
        if (res?.error === "NO_API_KEY") {
          renderEmpty("Add your TypeSafe API key in settings (⚙) to enable vibe checks.");
          setStatus("no key", "vc-err");
        } else {
          renderEmpty(res?.error || "Something went wrong.");
          setStatus("error", "vc-err");
        }
        return;
      }
      lastAnalyzedKey = key;
      render(res.rubrics, res.answers, res.usage, state);
      setStatus("");
    } catch (e) {
      renderEmpty(String(e?.message || e));
      setStatus("error", "vc-err");
    } finally {
      inFlight = false;
      if (pendingKey) { pendingKey = null; schedule(); }
    }
  }
  let pendingKey = null;

  function schedule() {
    if (!settings.autoAnalyze) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runAnalysis(false), settings.debounceMs);
  }

  // Draft.js swallows some events; listen broadly on the document.
  document.addEventListener("input", (e) => { if (e.target?.closest?.(TEXTBOX_SEL)) schedule(); }, true);
  document.addEventListener("keyup", (e) => { if (e.target?.closest?.(TEXTBOX_SEL)) schedule(); }, true);
  document.addEventListener("paste", (e) => { if (e.target?.closest?.(TEXTBOX_SEL)) schedule(); }, true);

  // Keep the panel attached across X's constant re-renders / route changes.
  let raf = 0;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const tbs = findTextboxes();
      const panel = document.getElementById(PANEL_ID);
      if (!tbs.length) { if (panel) { panel.remove(); currentHost = null; lastAnalyzedKey = ""; } return; }
      const host = findComposerHost(tbs[0]);
      if (!panel || !panel.isConnected || currentHost !== host) {
        ensurePanel(host);
        if (getDraftParts().join("").length >= MIN_CHARS || getContextTweets(tbs[0]).quoting) schedule();
        else renderEmpty("Start typing (or attach media) and I'll vibe check it.");
      }
      const sig = mediaSignature(tbs[0]);
      if (sig !== lastMediaSig) {
        lastMediaSig = sig;
        if (sig || getDraftParts().join("").length >= MIN_CHARS) schedule();
      }
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Cmd/Ctrl+Shift+V = manual check.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      runAnalysis(true);
    }
  });
})();
