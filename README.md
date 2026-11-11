# Peetty

A little companion for the web.

Peetty is an open-source, local-first browser pet. The idea is simple: a small companion that finds a quiet spot on the page, perches on a button or card, and is there when you want to talk.

Bring your own AI API key, shape its personality, and take its memories with you.

> **Status: early development.** Six animated presets, one-script embedding, OpenAI-compatible chat, independent Profiles, editable memories and history, and complete backup/restore are available. Released versions are published to GitHub Packages.

## The experience

- **At home on the page.** Rest on the edges of suitable visible elements, walk around, and occasionally jump to another spot. Keep text and important controls clear, and adapt when the page scrolls or changes.
- **Easy to reach.** Hover to reveal a small interaction area; click to open a chat window that stays open while you talk.
- **A little awareness.** Use lightweight, permitted page context to get a rough sense of what you are reading or doing, without needing to understand every action.
- **A familiar companion.** Back up your Profiles and restore their personalities, memories, conversations and model connections on another website or device.
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
    // headers: { 'X-Route': 'chat-a' },
    // nonCredentialHeaders: ['X-Route'] opts this routing header into persistence.
  },
  chat: {
    name: 'Miru',
    personality: 'A warm, curious companion who keeps replies concise.',
    storageKey: 'my-companion',
    // persist: false keeps all Profile data in memory for this visit.
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

The chat popup automatically chooses a matching gradient family from the host page's theme colours or visible primary controls. Neutral pages fall back to the character's image colour. It refreshes when opened, when the host's root theme changes, or when the viewport changes; scrolling does not continuously change the palette. Detection reads only local visual styles, not page text or images, and does not make network or model requests. The existing light/dark palettes retain readable contrast.

The chat UI uses a same-origin initial `about:blank` iframe built with DOM APIs, keeping typing and pointer events out of the embedding document's event path, including earlier capture listeners. Escape keeps focus inside that frame until key release, then restores the previous host focus. This is an event boundary; trusted scripts on the same origin can still access the UI and credentials.

Injected connections override saved settings for the current session. SDK `setModel()` calls leave the saved connection intact. Remembering an injected key defaults to off; saving it requires the user to check **Remember authentication on this device** and submit the setup form. Invalid `setModel()` replacements reject with a sanitized error and leave the last valid connection intact. Older asynchronous replacements are discarded after destruction or a newer replacement. Optional model headers apply to chat and model discovery only at the configured endpoint. Entering a replacement key overrides conflicting SDK authentication headers; explicitly clearing the key also disables the previous SDK credential callback for that setup connection. Header records must contain strings with valid HTTP names and values; they are normalized before replacing an active model. The setup form offers an explicit **Remember authentication on this device** checkbox. Saved settings and conversations use this origin's IndexedDB and fall back to memory when storage is unavailable. Instances sharing a storage key merge message changes transactionally, refresh shared history before each turn, and reject stale writes after history is cleared. Same-origin scripts can access browser-stored credentials: only enter a personal key on a website you trust. Never put a shared production secret in a public bundle, HTML attribute or example. Use a backend proxy when the embedding site supplies credentials for its visitors. `chat: false` disables chat entry points.

Thinking effort is configurable in setup and through `model.effort`: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Leave it at **Model default** to send no explicit effort. The selected model and endpoint must support the chosen level; existing request, output and timeout limits still apply.

Assistant replies render lightweight Markdown, including line breaks, lists, quotes, tables, inline code and fenced code blocks. Short speech-bubble replies share that formatting. Rendering builds DOM nodes without HTML string sinks: raw HTML stays literal, remote images stay alt text, and links accept only HTTP(S) destinations with no referrer. User messages and persisted history retain their original text.

The composer clears a message only after its credential and archive preflight succeeds and the user entry is accepted. A rejected or canceled preflight leaves the unsent draft available.

Chat supports streaming, stopping a response, clearing history, and model-selected actions (`wave`, `sit`, `lie`, `sleep`, `move`, `idle`). For models without tool-calling support, uncheck **Let the model control companion actions** in setup or inject `model: { ..., tools: false }` to send plain text chat without tools. Requests suppress the embedding page's referrer and omit browser cookies. If a credential callback is still pending when a turn is canceled or fails, its optimistic input is discarded before persistence because the callback's secret is not yet available for redaction. Canceled replies remain in history when safe to save, without a new speech bubble or completion announcement. Pi runs the tool loop; the local companion controls animation and finds safe landing spots. Action tools wait for their animation or clear landing before the next action starts; interrupted moves report failure, and stopping a reply cancels unfinished tools. Model requests have a time limit and a tool-call budget. Ordinary movement never calls the model, and no page text is automatically sent. Profile settings provide optional model-generated memories through a bounded `remember_fact` tool. This requires tool calling and companion tools to be enabled. Proactive conversations are not implemented.

## Profiles and settings

Open **Settings** from chat or the companion menu. Choose an existing Profile at the top, or create one in the Profile section. Each Profile has independent character selection, personality, memories, history and model connection. Selecting the same character in two Profiles does not share their data. Changing a Profile's character keeps its memories and history. Switching Profiles stops the previous reply, discards its unsent composer draft and prevents late callbacks from entering the new Profile.

| Area | Controls |
| --- | --- |
| Profile | Create and switch independent Profiles; edit their names, characters and personalities; delete a Profile after confirmation |
| Memory | Search, add, edit and delete memories; inspect source messages; toggle recall and optional automatic memory |
| History | Search, edit and delete conversation messages; expand long-message previews on demand |
| Connection | Provider name, API endpoint, model, API key, effort and tool preferences |
| Data | Complete backup/restore, memory JSON import/export and readable memory Markdown download |

Conversation archives are capped at 100,000 entries per Profile. A turn that cannot fit is rejected with an explicit capacity error before calling the model; export or remove history to continue. If another tab fills the archive during a reply, the unsaved turn remains visible with an error instead of disappearing on the next refresh.

Existing connection settings and history migrate automatically into the first Profile. Successfully copied legacy records are retired only after the new data is durably committed; failed or partial migration retains the old records for recovery. Cleanup is retried for existing or interrupted migrations using proof of copied records, without deleting concurrent legacy changes. If an older migration has no matching proof, Data settings provides a separately confirmed action to remove previous-format history and key copies while retaining current Profiles. Data uses this origin's IndexedDB and the SDK's `chat.storageKey` namespace; `chat.persist: false` keeps new Profile data in memory for the visit. Explicitly confirmed removal of previous-format copies still clears that namespace's old persistent data in this mode; deletion advances history and connection barriers so updated adapters reject stale writes. Close tabs still running earlier Peetty releases before cleanup: already-loaded old bundles cannot acquire the new connection-write checks. Automatic history retirement defers deletion while uncopied legacy entries remain, preserving active legacy replies. Barrier-only records do not make an empty namespace ineligible for first restore. No backend, account or automatic cross-site synchronization is required.

## Memory you can manage

Memories are separate from conversation history and personality. Enabled memories are supplied as a bounded block of user-editable data in model context. Automatic memory is off initially; when enabled, the model may use `remember_fact` to save stable facts explicitly stated in the current message. Old history is not scanned, and known connection credentials are rejected as model-generated memories. Manually edited memories are protected against automatic overwrites. Automatic writes recheck the latest opt-in and source message inside the storage transaction, so another tab's opt-out or source correction takes effect before a fact can be saved. Known authentication values are redacted before memory context is clipped; a per-Profile redaction registry remains in memory across runtime replacements and is cleared when that Profile or panel is removed.

Memories retain a source message reference and, when available, a source-text snapshot. Editing or deleting a source message leaves its memory available for inspection and correction. The settings interface explicitly asks you to review related memories. Memory imports deduplicate text and remove source IDs that would refer to another Profile.

## Backup and migration

**Data → Download full backup** produces version 2 `peetty-backup` JSON containing all Profiles, string references or inline character packs, personalities, memories, full stored history, Provider endpoints, model parameters, API keys and connection headers. Remembered connections and session-only overrides are separate records, so an SDK override cannot erase a saved Provider from the backup. Explicit backup resolves independent SDK credential callbacks concurrently; the callback functions themselves cannot be serialized. **The backup contains credentials in plain text. Keep it private.** Ordinary setup saves honor the authentication checkbox for both saved API keys and restored authentication headers. Recognized routing metadata stays with its endpoint when a key is rotated. Unclassified custom headers are treated as sensitive and are not retained without authentication consent. SDK callers can explicitly mark nonsecret routing names with `model.nonCredentialHeaders`, alongside their values in `model.headers`, so a header such as `X-Route` survives without saving the API key. Names are case-normalized; known authentication headers cannot be exempted, while explicitly classified metadata such as `X-Author`, `X-Key-Version` and `X-Subscription-Plan` is accepted. Compound authentication names such as `X-AuthToken` and `X-SecretKey` remain sensitive. A backup file cannot grant this trust: imported classifications are discarded, so custom routing exemptions must be declared again by the embedding SDK. Undeclared new SDK headers are not automatically persisted.

**Restore backup** accepts versions 1 and 2, validates the complete file before writing, creates fresh Profile and entry IDs, reconnects memory sources, and selects the restored active Profile. Existing Profiles are preserved; only a verified untouched bootstrap placeholder may be replaced when importing the maximum 100 Profiles into a fresh site. Restored session-only connections retain their original in-memory lifetime; save them with **Remember authentication on this device** to retain them on later visits. Remembered connections remain persisted independently. Restoring a connection does not call its model endpoint. Remote character loading has a 20-second deadline covering both the request and JSON body. An unavailable character leaves settings and data recovery accessible after the load fails. Memory source details retain the original evidence and indicate when the linked history message was edited. Files with unknown versions, invalid values or excessive sizes are rejected without partial imports.

Each backup/import file has a 50 MiB limit. Larger complete backups are split into numbered JSON parts. Keep every part, allow multiple downloads when prompted by the browser, and select all parts together when restoring; missing, duplicate or mixed sets are rejected before any Profiles are imported. Serialization and restoration process bounded JSON pieces without constructing one archive-sized string. Multipart export generates files lazily and limits live download files, so large exports may pause between batches; the export can be canceled during its yielding preflight scan or between files without invalidating files already downloading. The interface completes as soon as the final file starts downloading, independently of its URL retention timer. The 20-second callback deadline applies only to resolving credentials; archive serialization remains explicitly cancelable without that deadline. Persistence still uses one IndexedDB record per Profile, so large histories incur whole-record I/O; bounded paging and narrow memory reads avoid extra full-archive copies but do not split that storage record.

**Download memory JSON** and **Import memory JSON** transfer only the current Profile's memories using the `peetty-memories` format. JSON and Markdown downloads wait for queued writes and read the latest committed memories. Memory-only downloads omit source-message text and references; use a complete backup to retain that conversation evidence. Imports merge without overwriting existing memories or connections. **Download memory Markdown** provides a readable copy. To migrate to another website or device, download a complete backup there and restore it in the destination's Data settings.

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

Load the prebuilt browser distribution from jsDelivr, without requests to `peetty.idy.dev`. No npm install, GitHub login or build step is needed, and no separate stylesheet is required. The examples pin v0.4.0 and require its matching GitHub release tag. The `cdn/` distribution is available from v0.3.1 onward; each version retains its own assets and bundled third-party license notices.

For an automatically mounted companion, add a classic script tag:

```html
<script src="https://cdn.jsdelivr.net/gh/idy/peetty@v0.4.0/cdn/peetty.global.js"
        data-peetty-auto data-figure="miru" defer></script>
```

For JavaScript control, import the browser ES module directly:

```html
<script type="module">
  import { createPeetty } from 'https://cdn.jsdelivr.net/gh/idy/peetty@v0.4.0/cdn/index.js';

  const pet = createPeetty({ figure: 'koharu' });
  await pet.mount();
  // Optional: open chat and configure your own model in the UI.
  // await pet.openChat();
</script>
```

The classic script also exposes `window.Peetty.createPeetty()` for manual setup when `data-peetty-auto` is omitted. Use `cdn/index.js` for named ES module imports and `cdn/peetty.global.js` for classic scripts. Dependencies, styles and six preset figures are bundled. Chat modules and extra figures load from the same CDN host and version as the entry script; the catalog contains portable relative URLs.

The generated `cdn/` directory is checked into Git so jsDelivr can read a version tag directly. GitHub Packages is optional and is not involved in CDN downloads. To self-host a CDN build, copy the complete `cdn/` and `figures/` directories as siblings, preserving `cdn/chat/`, `cdn/chunks/` and `cdn/THIRD_PARTY_NOTICES.txt`. The npm ESM and classic builds keep the historical `https://peetty.idy.dev/figures/` fallback so existing CSP allowlists and deployments without local figures continue working. CDN and website browser entries use their sibling catalog and do not contain that package fallback.

Both CDN and npm distributions include `THIRD_PARTY_NOTICES.txt` with licenses and notices for the dependencies present in their bundle graph. Per-file license comments are retained. Website assembly uses the CDN browser entries and retains portable catalog URLs by default, so development and mirrors resolve figures on their own origin. The official Pages workflow passes `--catalog-base https://peetty.idy.dev/figures/` to preserve absolute URLs for SDK 0.3.0 clients at its historical endpoint. Other deployments can pass their own catalog base. The repository's CDN index remains relative.

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

Release workflow: set the version in `package.json` and `package-lock.json`, update the pinned examples (the browser fallback is derived from the package version), run `npm run figures` and `npm run build`, and commit the source together with `cdn/` before pushing the matching tag, such as `v0.3.1`. The tag makes the prebuilt files publicly readable through jsDelivr. The package workflow checks that the tag matches `package.json`, runs the checks, tests and build, then publishes to GitHub Packages using `GITHUB_TOKEN` and reads the exact version back from the registry to verify publication. Publishing a new version and changing the package's visibility are separate GitHub operations.

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

`npm run dev` serves the figure sheet at `http://127.0.0.1:4180/dev/figures.html` and the website at `http://127.0.0.1:4180/site/`, rebuilding on each change. `npm run build` writes `dist/index.js` (ESM), `dist/peetty.global.js` (a `Peetty` global for script tags), and the checked-in `cdn/` browser distribution without source maps. `npm run build:cdn` regenerates only the CDN files. `npm run build:site` assembles website assets from `cdn/` with portable catalogs; add `-- --catalog-base https://your-host.example/figures/` when an absolute legacy catalog is needed. `npm run figures` regenerates the preset JSON from its sources; `npm run check` type-checks and verifies that generated figure JSON and the checked-in CDN build are current.

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
| `src/global.ts` | npm classic entry with automatic mounting and a public catalog fallback |
| `src/browser-global.ts` | CDN/website classic entry with a sibling catalog |
| `scripts/site.mjs` | Assemble production browser assets and the legacy website catalog |
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
