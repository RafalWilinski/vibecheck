# Vibe Check for X (powered by Jev)

A Chrome and Firefox extension that runs your draft post through [TypeSafe's Jev](https://docs.typesafe.ai) before you hit **Post**. It renders a scorecard under the composer with virality, funniness, informativeness, clarity, insult level, ragebait, cringe, "sounds AI-written", regret risk, typo detection, and the most likely crowd reaction, plus an overall "Send it / Fine, mid / Probably don't / Sleep on it" verdict.

Works in the `/compose/post` modal, the inline composer on Home, reply composers, quote posts, and multi-post threads. The tweet you're replying to is sent along as `reply_to` and a quoted tweet as `quoting` (text, author, and described photos), so insult level, virality and likely reaction are judged against that context. Plain retweets have no compose step, so there's nothing to check.

**Images and video:** Jev is text-only. If you add an OpenAI API key, every attached image (and the first frame of each video/GIF) is described by an OpenAI vision model and the description is passed to Jev as `media`. Photos on the tweet you're replying to are described too. Two extra rubrics ("Media helps", "Media risk") are asked only when media is present. Descriptions are cached per attachment, so you pay for each image once, not on every keystroke.

## Install

Download or clone this repository first. No build step is needed.

### Chrome (121+)

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `vibecheck` folder.

### Firefox desktop (140+)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.

Temporary add-ons are removed when Firefox restarts; reload the manifest to use it again. A persistent installation in standard Firefox requires a Mozilla-signed add-on; this repository does not include a signed package.

Firefox declares website content and personal communications as required data permissions because analysis sends your draft and reply/quote context to TypeSafe, and optional media description sends images/video frames to OpenAI. Firefox 140+ supports these built-in data-consent declarations. If the panel does not appear or API requests fail, check the extension's site permissions in `about:addons` and allow access to X and the API hosts, then reload the X tab.

### Configure (both browsers)

1. The settings page opens on installation; you can also click the extension's toolbar icon to open it.
2. Paste your TypeSafe API key and click **Test key**. Optionally paste an OpenAI API key, set the vision model (defaults to `gpt-4o-mini`; any OpenAI chat model that accepts images works), and click **Test key + model**. Click **Save** after configuring your keys.
3. Go to https://x.com/compose/post and start typing. Reload any X tabs that were already open when the extension was installed.

## Usage

- Auto-analyze fires ~1.2 s after you stop typing (configurable, or disable it).
- **Check** button or `⌘⇧V` / `Ctrl+Shift+V` forces a run.
- Hover any metric to see the rubric and the level Jev landed on.
- Expand "What Jev was told about N attached items" to read the exact media descriptions Jev received.
- `⚙` opens settings. `▾` collapses the panel (remembered).

## Customizing rubrics

Settings → **Rubrics (JSON)**. Each entry:

```json
{
  "id": "spicy",
  "label": "Spiciness",
  "type": "score",
  "polarity": "neutral",
  "weight": 0,
  "instructions": "How spicy a take is `draft`?",
  "criteria": ["Lukewarm", "Mild", "Medium", "Hot", "Nuclear"]
}
```

- `type`: `score` (ordered levels low→high, 2–10), `noul` (yes/no probability, optional `criteria: {true, false}`), `choice` (`criteria: {option: description}`).
- `"requires": "media"` makes a rubric conditional on attached media.
- `polarity` + `weight` feed the verdict: `good` metrics push it up, `bad` push it down, `neutral` / weight 0 are display-only. Any `bad` metric at ≥75% forces "Sleep on it".
- All questions go to Jev in **one request** and are evaluated in parallel against the same state, so adding rubrics costs tokens but not latency.

## How it works

- `content.js` finds X's Draft.js composer (`data-testid="tweetTextarea_*"`), reads the text, and inserts the panel after the composer toolbar. A MutationObserver keeps it attached through X's re-renders.
- Attached media lives in X's `data-testid="attachments"` block as `blob:` URLs. The content script fetches each blob, downscales it to 1024px JPEG on a canvas (or grabs a video frame), and hands it to the background worker as a data URL. Reply-context photos are public `pbs.twimg.com` URLs and are passed through directly.
- `background.js` (a service worker in Chrome, an event page in Firefox) reads both API keys from extension storage. It POSTs media to `https://api.openai.com/v1/chat/completions` for a neutral description (subjects, verbatim text, meme format, sensitive content), then POSTs the draft + descriptions to `https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"`. Both calls retry on 429/5xx with backoff.
- `rubrics.js` is the default question set. Scores are normalized to 0–1 in the content script and combined into the verdict in code, per TypeSafe's composite-scoring pattern.

## Cost

Each Jev analysis is roughly 1.5k–2.5k input tokens (rubrics dominate), i.e. a fraction of a cent at Jev's published price. Output tokens are free. Each image description is one vision call to OpenAI, cached per attachment.

## Caveats

- X changes its DOM without notice. If the panel disappears, the selectors at the top of `content.js` are the place to look.
- Both keys live in extension `storage.sync` and never touch the x.com page context, but these are still client-side keys; use keys you can rotate. Chrome and Firefox have separate settings; keys do not transfer between browsers.
- Video/GIF support describes a single frame only, so motion-dependent jokes will be under-read.

## Development checks

Run `node --test` with Node.js 22+ for the dependency-free background compatibility tests. These exercise Chrome's worker and Firefox's event-page loading, API namespace selection, and asynchronous message responses without contacting either provider.

For browser verification, load the extension in a fresh profile in each browser and check settings save/reload, the toolbar/settings button, manual and automatic analysis, replies/quotes/threads, and image/video attachments. Use test data and your own API keys; these checks send data to the configured providers. Unit tests alone do not verify X's current DOM or live API behavior.

Keep the Gecko ID in `manifest.json` stable: Firefox uses it for `storage.sync`. Both background entries are intentional; Chrome 121+ uses `service_worker`, while Firefox uses the ordered `scripts` list. Older Chrome versions reject the Firefox background entry in a Manifest V3 extension, which is why the shared manifest declares Chrome 121 as its minimum.
