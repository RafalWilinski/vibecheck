const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

function loadBackground(browser, settings = {}, fetch = () => {
  throw new Error("Unexpected provider request");
}) {
  const listeners = {};
  const imports = [];
  let optionsOpened = 0;
  const extension = {
    action: { onClicked: { addListener: (fn) => { listeners.clicked = fn; } } },
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      openOptionsPage: () => { optionsOpened++; },
    },
    storage: { sync: { get: async () => settings } },
  };
  const context = vm.createContext({ fetch, setTimeout });
  const run = (file) => vm.runInContext(readFileSync(join(root, file), "utf8"), context, { filename: file });
  if (browser === "Chrome") {
    context.chrome = extension;
    context.importScripts = (file) => { imports.push(file); run(file); };
    run(manifest.background.service_worker);
  } else {
    context.browser = extension;
    context.chrome = new Proxy({}, { get() { throw new Error("Firefox must use browser, not chrome"); } });
    for (const file of manifest.background.scripts) run(file);
  }
  return {
    listeners,
    imports,
    get optionsOpened() { return optionsOpened; },
    send: (message) => new Promise((resolve) => {
      const keepAlive = listeners.message(message, {}, (response) => resolve(structuredClone(response)));
      assert.equal(keepAlive, true, "async responses must keep the message channel open without an async listener");
    }),
  };
}

test("manifest supports both backgrounds and Firefox sync/data permissions", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.background.scripts, ["rubrics.js", "background.js"]);
  assert.ok(Number(manifest.minimum_chrome_version) >= 121);
  const gecko = manifest.browser_specific_settings.gecko;
  assert.match(gecko.id, /^\{[0-9a-f-]{36}\}$/);
  assert.ok(Number(gecko.strict_min_version) >= 140);
  assert.ok(manifest.permissions.includes("storage"));
  assert.deepEqual(gecko.data_collection_permissions.required, ["websiteContent", "personalCommunications"]);
});

for (const browser of ["Chrome", "Firefox"]) {
  test(`${browser}: starts its background and registers options handlers`, () => {
    const background = loadBackground(browser);
    assert.deepEqual(background.imports, browser === "Chrome" ? ["rubrics.js"] : []);
    background.listeners.installed({ reason: "update" });
    assert.equal(background.optionsOpened, 0);
    background.listeners.installed({ reason: "install" });
    background.listeners.clicked();
    assert.equal(background.optionsOpened, 2);
    assert.equal(background.listeners.message({ type: "unknown" }, {}, () => assert.fail()), false);
  });

  test(`${browser}: returns public settings without exposing API keys`, async () => {
    const background = loadBackground(browser, { apiKey: "test-key", openaiKey: "test-vision-key" });
    assert.deepEqual(await background.send({ type: "vibecheck:getSettings" }), {
      ok: true, settings: { describeMedia: true, hasOpenAI: true },
    });
  });

  test(`${browser}: returns missing-key errors asynchronously`, async () => {
    const background = loadBackground(browser);
    assert.deepEqual(await background.send({ type: "vibecheck:analyze", state: { draft: "Test draft" } }), {
      ok: false, error: "NO_API_KEY",
    });
    assert.deepEqual(await background.send({ type: "vibecheck:describe", dataUrl: "data:image/jpeg;base64,dGVzdA==" }), {
      ok: false, error: "NO_OPENAI_KEY",
    });
  });

  test(`${browser}: loads default rubrics and delivers an analysis response`, async () => {
    const requests = [];
    const answers = { clarity: { type: "score", score: 2 } };
    const background = loadBackground(browser, { apiKey: "test-key" }, async (url, init) => {
      requests.push({ url, ...init, body: JSON.parse(init.body) });
      return Response.json({ answers, model: "jev-latest", usage: { input_tokens: 100 } });
    });
    const state = { draft: "A synthetic draft", reply_to: { text: "A synthetic reply" } };
    const result = await background.send({ type: "vibecheck:analyze", state });
    assert.equal(result.ok, true);
    assert.deepEqual(result.answers, answers);
    assert.ok(result.rubrics.length > 0);
    assert.ok(result.rubrics.every((rubric) => !rubric.requires));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(requests[0].headers.Authorization, "Bearer test-key");
    assert.deepEqual(requests[0].body.state, state);
    assert.deepEqual(Object.keys(requests[0].body.questions), result.rubrics.map((rubric) => rubric.id));
  });

  test(`${browser}: delivers media descriptions through the message channel`, async () => {
    const dataUrl = "data:image/jpeg;base64,dGVzdA==";
    const background = loadBackground(browser, { openaiKey: "test-vision-key" }, async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(init.body);
      assert.equal(body.messages[0].content[1].image_url.url, dataUrl);
      assert.match(body.messages[0].content[0].text, /single frame/);
      return Response.json({ choices: [{ message: { content: " A synthetic frame. " } }] });
    });
    assert.deepEqual(await background.send({ type: "vibecheck:describe", kind: "video", dataUrl }), {
      ok: true, description: "A synthetic frame.",
    });
  });

  test(`${browser}: forwards provider failures rather than losing the response`, async () => {
    const background = loadBackground(browser, { apiKey: "invalid-test-key" }, async () => new Response("Unauthorized", { status: 401 }));
    const result = await background.send({ type: "vibecheck:analyze", state: { draft: "Test draft" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid API key \(401\)/);
  });
}
