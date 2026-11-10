# Peetty

A little companion for the web.

Peetty is an open-source, local-first browser pet. The idea is simple: a small companion that finds a quiet spot on the page, perches on a button or card, and is there when you want to talk.

Bring your own AI API key, shape its personality, and take its memories with you.

> **Status: early development.** The companion, chat and connection settings work: six animated presets, a JSON figure format, one-script embedding, OpenAI-compatible models and AI-triggered actions. Editable long-term memory and a dedicated management page are planned. Released versions are published to GitHub Packages.

## The experience

- **At home on the page.** Rest on the edges of suitable visible elements, walk around, and occasionally jump to another spot. Keep text and important controls clear, and adapt when the page scrolls or changes.
- **Easy to reach.** Hover to reveal a small interaction area; click to open a chat window that stays open while you talk.
- **A little awareness.** Use lightweight, permitted page context to get a rough sense of what you are reading or doing, without needing to understand every action.
- **A familiar companion.** Keep the same personality, memories, and conversations as you move between websites.
- **Quiet company.** Run movement and idle behavior locally, with configurable activity and interruptions. An AI connection is for conversation, not every animation frame.

## Chat and model configuration

Double-click the companion to open chat. Right-click for actions and connection settings; the hover menu also has a Chat button. Touch users can tap to open the menu, and keyboard users can focus the companion and press Enter. Screen-reader click activation also opens chat. The website also provides a **Chat with her** button.

On the first visit, enter an OpenAI-compatible API base URL and your API key, load the model list, choose a model, and save. If model discovery is unavailable, enter the model ID manually. Keyless local endpoints are supported. Use the actual API base path: root-level endpoints stay at the root, and `/v1` is never inserted automatically. Requests do not follow HTTP redirects, so use the final API base URL. The endpoint must permit browser requests through CORS; an SDK or browser setting cannot bypass a provider's restrictions. An HTTPS website may also block HTTP endpoints.

The **Use local Magpie** shortcut fills `http://127.0.0.1:3425/v1`. Start Magpie on the device running the browser, allow the current website origin in **Settings → Network and sharing → Web pages**, create a gateway key in Magpie's **Gateway → Gateway keys** and enter it, then load and select a model. Website authorization and gateway-key authentication are separate; a 401 response means gateway authentication failed. The shortcut never copies credentials from a different endpoint. HTTPS pages accessing HTTP loopback depend on browser support, local-network permissions and Magpie's CORS policy; this is not a universal browser bypass. An HTTPS public server cannot proxy a visitor's `127.0.0.1` gateway.

SDK callers can use `model: { ...LOCAL_MAGPIE, id: 'your-model-id', apiKey: yourGatewayKey }`, importing `LOCAL_MAGPIE` from `@idy/peetty`. The preset contains only the loopback base URL, with no embedded key or default model.

The SDK can inject the connection directly, including an asynchronous credential callback:

```js
import { createPeetty } from '@idy/peetty';

const pet = createPeetty({
  figure: 'miru',
  model: {
    baseUrl: 'https://your-api.example/v1',
    id: 'your-model-id',
    getApiKey: async () => yourUserProvidedKey,
    // apiKey: 'your-user-provided-key' is also supported.
    // effort: 'high' requests explicit reasoning effort when the model supports it.
  },
  chat: {
    name: 'Miru',
    personality: 'A warm, curious companion who keeps replies concise.',
    storageKey: 'my-companion',
    // persist: false disables saving the connection and conversation.
  },
});
await pet.mount();
await pet.openChat();

// Replace the model without rebuilding the companion.
await pet.setModel({ baseUrl: 'https://your-api.example/v1', id: 'another-model', apiKey: yourUserProvidedKey });
// Translate controls in place, retaining chat, drafts and in-memory credentials.
pet.setLanguage('zh'); // Also accepts 'en' and 'auto'.
pet.closeChat();
// await pet.configure();
```

Mounting the companion makes no AI requests. Chat, Markdown tokenization and provider code load on demand. Script-tag embeds load the adjacent `chat/` and `chunks/` directories; self-host the complete browser distribution with its sibling `figures/` catalog, not just `peetty.global.js`.

The chat UI uses a same-origin initial `about:blank` iframe built with DOM APIs, keeping typing and pointer events out of the embedding document's event path, including earlier capture listeners. Escape keeps focus inside that frame until key release, then restores the previous host focus. This is an event boundary; trusted scripts on the same origin can still access the UI and credentials.

Injected connections override saved settings for the current session. SDK `setModel()` calls leave the saved connection intact. Remembering an injected key defaults to off; saving it requires the user to check **Remember my key on this device** and submit the setup form. Invalid `setModel()` replacements reject with a sanitized error and leave the last valid connection intact. Older asynchronous replacements are discarded after destruction or a newer replacement. Optional model headers apply to chat and model discovery only at the configured endpoint. Entering a replacement key overrides conflicting SDK authentication headers; explicitly clearing the key also disables the previous SDK credential callback for that setup connection. Header records must contain strings with valid HTTP names and values; they are normalized before replacing an active model. The setup form offers an explicit **Remember my key on this device** checkbox. Saved settings and conversations use this origin's IndexedDB and fall back to memory when storage is unavailable. Instances sharing a storage key merge message changes transactionally, refresh shared history before each turn, and reject stale writes after history is cleared. Same-origin scripts can access browser-stored credentials: only enter a personal key on a website you trust. Never put a shared production secret in a public bundle, HTML attribute or example. Use a backend proxy when the embedding site supplies credentials for its visitors. `chat: false` disables chat entry points.

Thinking effort is configurable in setup and through `model.effort`: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Leave it at **Model default** to send no explicit effort. The selected model and endpoint must support the chosen level; existing request, output and timeout limits still apply.

Assistant replies render lightweight Markdown, including line breaks, lists, quotes, tables, inline code and fenced code blocks. Short speech-bubble replies share that formatting. Rendering builds DOM nodes without HTML string sinks: raw HTML stays literal, remote images stay alt text, and links accept only HTTP(S) destinations with no referrer. User messages and persisted history retain their original text.

Chat supports streaming, stopping a response, clearing history, and model-selected actions (`wave`, `sit`, `lie`, `sleep`, `move`, `idle`). For models without tool-calling support, uncheck **Let the model control companion actions** in setup or inject `model: { ..., tools: false }` to send plain text chat without tools. Requests suppress the embedding page's referrer and omit browser cookies. If a credential callback is still pending when a turn is canceled or fails, its optimistic input is discarded before persistence because the callback's secret is not yet available for redaction. Canceled replies remain in history when safe to save, without a new speech bubble or completion announcement. Pi runs the tool loop; the local companion controls animation and finds safe landing spots. Action tools wait for their animation or clear landing before the next action starts; interrupted moves report failure, and stopping a reply cancels unfinished tools. Model requests have a time limit and a tool-call budget. Ordinary movement never calls the model, and no page text is automatically sent. Automatic long-term memory and proactive conversations are not implemented yet.

## Make it yours

A dedicated management page is planned for:

| Area | Controls |
| --- | --- |
| Personality | Name, personality prompt, tone, and interaction preferences |
| AI connection | Provider, endpoint, model, and your own API key |
| Conversations | Browse, search, edit, and delete conversation history |
| Memory | Inspect, add, edit, and delete remembered facts and preferences |
| Page awareness | Control access to page context and disable it for individual websites |
| Data | Export, import, back up, and clear local data |

## Memory you can manage

Conversation history, long-term memory, and pet settings are separate parts of the intended data model. You should be able to inspect what Peetty remembers and correct it directly.

Automatically extracted memories should retain a reference to their source conversation. Editing or deleting history should let you review and update related memories and summaries, so an old belief does not silently outlive its source.

Portable JSON exports are planned for pet settings, memories, and optional conversation history. API keys are excluded from exports by default.

## Local-first, with clear boundaries

The initial design keeps settings, conversations, and memories on your device, without requiring a Peetty account or a project-operated backend.

Local storage does not make cloud AI offline. When you chat, your message, relevant memories, recent conversation, and any permitted page context are sent to the model endpoint you configure.

Page awareness is intended to be lightweight and user-controlled: for example, a page title, URL, selected text, or a limited excerpt of visible content. Passwords and form inputs are excluded from automatic collection. API keys should stay in extension-controlled storage and should never be injected into website scripts.

Browser data can be cleared or lost. Export and import are part of the initial scope so you can back up your companion or move it to another browser or device.

Browser connections also depend on the selected provider's cross-origin support and authentication requirements. Compatibility will be documented as integrations are implemented.

## Figures

Peetty's look is a JSON figure pack: layered vector parts on a standard skeleton, a palette, and expression states. The SDK animates any figure, with breathing, blinking, pointer-following eyes, spring-driven hair, and squash and stretch on jumps. Six original presets are bundled:

- **Miru**: lavender twin tails and a cursor hair clip. Quick and bouncy.
- **Koharu** (Japan): a peach bob and a cat-ear beret. Sleepy, naps and stretches.
- **Xiaoxiao** (China): black double buns and a cup of milk tea.
- **Riley** (US): a chestnut ponytail; blows bubble gum and jumps the highest.
- **Amara** (US): curly afro puffs and a camera she snaps photos with.
- **Elsie** (UK): a blonde bob and freckles; sips tea and floats down under her umbrella.

More characters, such as Shiori, live in the catalog in `figures/` and load on demand. Each character has its own short action sounds, configured in the figure's optional `sounds.events` JSON. The bundled sounds synthesize locally without downloads; custom packs can use strictly preflighted integer PCM WAV files and random variants. Sound is off by default: enable it in the companion's menu to hear a preview, or pass `sound: { enabled: true, volume: 0.6 }` to the SDK (`data-sound="true"` for script tags). A browser user gesture is still required. Use `pet.setSound(false)` to mute and `pet.previewSound('jump')` inside a click handler to audition a cue. See [Figure packs](docs/figures.md#action-sounds) for the JSON format and [Figure packs](docs/figures.md) to make your own or recolor a preset.

## Project direction

Peetty is first built as a browser SDK that any page can load directly from a CDN or install with npm. [peetty.idy.dev](https://peetty.idy.dev/) uses the same browser build. A browser extension then reuses the same core, so the same companion follows you across websites with its key in extension storage. A Tauri desktop companion is a possible later direction.

When embedded through the SDK, settings and any saved key live in that website's own storage, where other scripts on the same site could read them. Key handling for SDK embeds will be documented with the chat feature, including a mode that does not persist the key.

## Use from a CDN (no installation)

Load the prebuilt browser distribution from jsDelivr, without requests to `peetty.idy.dev`. No npm install, GitHub login or build step is needed, and no separate stylesheet is required. The `v0.3.1` URLs below become available after that release tag is pushed; older tags do not contain the `cdn/` distribution.

For an automatically mounted companion, add a classic script tag:

```html
<script src="https://cdn.jsdelivr.net/gh/idy/peetty@v0.3.1/cdn/peetty.global.js"
        data-peetty-auto data-figure="miru" defer></script>
```

For JavaScript control, import the browser ES module directly:

```html
<script type="module">
  import { createPeetty } from 'https://cdn.jsdelivr.net/gh/idy/peetty@v0.3.1/cdn/index.js';

  const pet = createPeetty({ figure: 'koharu' });
  await pet.mount();
  // Optional: open chat and configure your own model in the UI.
  // await pet.openChat();
</script>
```

The classic script also exposes `window.Peetty.createPeetty()` for manual setup when `data-peetty-auto` is omitted. Use `cdn/index.js` for named ES module imports and `cdn/peetty.global.js` for classic scripts. Dependencies, styles and six preset figures are bundled. Chat modules and extra figures load from the same CDN host and version as the entry script; the catalog contains portable relative URLs.

The generated `cdn/` directory is checked into Git so jsDelivr can read a version tag directly. GitHub Packages is optional and is not involved in CDN downloads. To self-host a fixed build, copy the complete `cdn/` and `figures/` directories as siblings, preserving `cdn/chat/` and `cdn/chunks/`.

## Install from GitHub Packages (optional)

The package is named `@idy/peetty` and is published to GitHub Packages. GitHub Packages requires authentication, including for public packages. Route only the `@idy` scope there so Pi, OpenAI and other dependencies continue to resolve from the default npm registry. Configure the scope and authenticate with a GitHub account that can read the package, using a personal access token (classic) with `read:packages`:

```bash
npm config set @idy:registry https://npm.pkg.github.com
```

```bash
npm login --scope=@idy --auth-type=legacy --registry=https://npm.pkg.github.com
```

```bash
npm install @idy/peetty
```

Release workflow: set the version in `package.json` and `package-lock.json`, update the fallback catalog in `src/catalog.ts` and the pinned examples, run `npm run figures` and `npm run build`, and commit the source together with `cdn/` before pushing the matching tag, such as `v0.3.1`. The tag makes the prebuilt files publicly readable through jsDelivr. The package workflow checks that the tag matches `package.json`, runs the checks, tests and build, then publishes to GitHub Packages using `GITHUB_TOKEN` and reads the exact version back from the registry to verify publication. Publishing a new version and changing the package's visibility are separate GitHub operations.

## Development

Requires Node.js 22.19 or later.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run check
```

`npm run dev` serves the figure sheet at `http://127.0.0.1:4180/dev/figures.html` and the website at `http://127.0.0.1:4180/site/`, rebuilding on each change. `npm run build` writes `dist/index.js` (ESM), `dist/peetty.global.js` (a `Peetty` global for script tags), and the checked-in `cdn/` browser distribution without source maps. `npm run build:cdn` regenerates only the CDN files. `npm run figures` regenerates the preset JSON from its sources; `npm run check` type-checks and verifies that generated figure JSON and the checked-in CDN build are current.

| Path | Purpose |
| --- | --- |
| `src/figure/types.ts` | Figure format types, bones, slots and states |
| `src/figure/validate.ts` | Validator for untrusted figure data |
| `src/figure/rig.ts` | SVG renderer: bone matrices, springs, slots, gaze |
| `src/figure/motion.ts` | Procedural animation for every state |
| `src/figure/view.ts` | Animated figure element with its frame loop |
| `src/figure/sources.ts` | Audio asset bases kept outside the validated figure JSON |
| `figures/src/` | Preset sources and the drawing kit |
| `figures/*.json` | Generated preset figure packs |
| `schema/figure-v1.json` | JSON Schema for editors |
| `src/pet/` | The companion: perch finding, jump physics, behaviour, dragging, hover menu, bubble and action sounds |
| `src/global.ts` | Script-tag build with `data-peetty-auto` |
| `src/browser.ts` | CDN ES module entry with a catalog relative to its own URL |
| `cdn/` | Checked-in browser distribution served directly by jsDelivr |
| `scripts/cdn.mjs` | Generate and verify the browser distribution |
| `site/` | peetty.idy.dev, with the shared idy.dev shell in `site/shared/` |
| `.github/workflows/pages.yml` | Checks on every PR; builds and deploys `site/` to GitHub Pages from `main` |
| `.github/workflows/package.yml` | Checks and publishes matching version tags to GitHub Packages |
| `.github/workflows/codex-review.yml` | Shared Codex review for PRs, review requests, and linked-Issue updates |
| `dev/figures.html` | Figure sheet for reviewing presets |
| `test/` | Figure validation, presets, motion, companion lifecycle and perch tests |

## Contributing

Ideas, interaction feedback, and technical discussion are welcome in [GitHub Issues](https://github.com/idy/peetty/issues). The first milestone is a small, usable browser companion with thoughtful movement, chat, editable memory, and data portability.

Pull requests use the [shared GizClaw Codex reviewer](https://github.com/GizClaw/github-workflows) through `.github/workflows/codex-review.yml`, following its moving `latest` release. Maintainers must configure an `OPENAI_API_KEY` repository Actions secret; the caller forwards only that secret explicitly. Review runs on the trusted default branch and treats proposed changes as data.

Once the caller is on `main`, opening or updating a ready PR starts a review automatically. A new PR comment with `@codex review` on its own line requests another review; **Actions → OpenAI PR review → Run workflow** accepts a PR number as a manual fallback. Linked-Issue updates also refresh the associated open PRs. Results appear on the reviewed commit as `OpenAI PR Review`, `OpenAI Issue Review`, and `OpenAI Code Review`. The `main` branch requires the GitHub Actions `check`, `OpenAI PR Review`, `OpenAI Issue Review`, and `OpenAI Code Review` checks, an up-to-date branch, and resolved review conversations. These gates also apply to administrators; force pushes and branch deletion are disabled. Auto-merge is available once the gates pass. Closing Issues are optional.

## License

[MIT](LICENSE)
