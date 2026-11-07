# Peetty

A little companion for the web.

Peetty is an open-source, local-first browser pet. The idea is simple: a small companion that finds a quiet spot on the page, perches on a button or card, and is there when you want to talk.

Bring your own AI API key, shape its personality, and take its memories with you.

> **Status: early development.** The companion works on real pages: six animated preset characters, a JSON format for your own, and one-script embedding. Chat, memory and the management page are not built yet. Released versions are published to GitHub Packages. The capabilities below describe the intended product.

## The experience

- **At home on the page.** Rest on the edges of suitable visible elements, walk around, and occasionally jump to another spot. Keep text and important controls clear, and adapt when the page scrolls or changes.
- **Easy to reach.** Hover to reveal a small interaction area; click to open a chat window that stays open while you talk.
- **A little awareness.** Use lightweight, permitted page context to get a rough sense of what you are reading or doing, without needing to understand every action.
- **A familiar companion.** Keep the same personality, memories, and conversations as you move between websites.
- **Quiet company.** Run movement and idle behavior locally, with configurable activity and interruptions. An AI connection is for conversation, not every animation frame.

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

More characters, such as Shiori, live in the catalog in `figures/` and load on demand. See [Figure packs](docs/figures.md) to make your own or recolor a preset.

## Project direction

Peetty is first built as an npm SDK that any page can embed with one script, which is how [peetty.idy.dev](https://peetty.idy.dev/) will host it. A browser extension then reuses the same core, so the same companion follows you across websites with its key in extension storage. A Tauri desktop companion is a possible later direction.

When embedded through the SDK, settings and any saved key live in that website's own storage, where other scripts on the same site could read them. Key handling for SDK embeds will be documented with the chat feature, including a mode that does not persist the key.

## Install from GitHub Packages

The package is named `@idy/peetty` and is published to GitHub Packages. GitHub Packages requires authentication, including for public packages. Configure the scope and authenticate with a GitHub account that can read the package, using a personal access token (classic) with `read:packages`:

```bash
npm config set @idy:registry https://npm.pkg.github.com
```

```bash
npm login --scope=@idy --auth-type=legacy --registry=https://npm.pkg.github.com
```

```bash
npm install @idy/peetty
```

Release workflow: after the intended version is on the repository, push a matching tag such as `v0.1.0`. The package workflow checks that the tag matches `package.json`, runs the checks, tests and build, then publishes to GitHub Packages using `GITHUB_TOKEN`. Publishing a new version and changing the package's visibility are separate GitHub operations.

## Development

Requires Node.js 22.18 or later.

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

`npm run dev` serves the figure sheet at `http://127.0.0.1:4180/dev/figures.html` and the website at `http://127.0.0.1:4180/site/`, rebuilding on each change. `npm run build` writes `dist/index.js` (ESM) and `dist/peetty.global.js` (a `Peetty` global for script tags). `npm run figures` regenerates the preset JSON from its sources; `npm run check` type-checks and verifies that the generated JSON is current.

| Path | Purpose |
| --- | --- |
| `src/figure/types.ts` | Figure format types, bones, slots and states |
| `src/figure/validate.ts` | Validator for untrusted figure data |
| `src/figure/rig.ts` | SVG renderer: bone matrices, springs, slots, gaze |
| `src/figure/motion.ts` | Procedural animation for every state |
| `src/figure/view.ts` | Animated figure element with its frame loop |
| `figures/src/` | Preset sources and the drawing kit |
| `figures/*.json` | Generated preset figure packs |
| `schema/figure-v1.json` | JSON Schema for editors |
| `src/pet/` | The companion: perch finding, jump physics, behaviour, dragging, hover menu and bubble |
| `src/global.ts` | Script-tag build with `data-peetty-auto` |
| `site/` | peetty.idy.dev, with the shared idy.dev shell in `site/shared/` |
| `.github/workflows/pages.yml` | Checks on every PR; builds and deploys `site/` to GitHub Pages from `main` |
| `.github/workflows/package.yml` | Checks and publishes matching version tags to GitHub Packages |
| `.github/workflows/codex-review.yml` | Shared Codex review for PRs, review requests, and linked-Issue updates |
| `dev/figures.html` | Figure sheet for reviewing presets |
| `test/` | Figure validation, presets, motion, companion lifecycle and perch tests |

## Contributing

Ideas, interaction feedback, and technical discussion are welcome in [GitHub Issues](https://github.com/idy/peetty/issues). The first milestone is a small, usable browser companion with thoughtful movement, chat, editable memory, and data portability.

Pull requests use the [shared GizClaw Codex reviewer](https://github.com/GizClaw/github-workflows) through `.github/workflows/codex-review.yml`, following its moving `latest` release. Maintainers must configure an `OPENAI_API_KEY` repository Actions secret; the caller forwards only that secret explicitly. Review runs on the trusted default branch and treats proposed changes as data.

Once the caller is on `main`, opening or updating a ready PR starts a review automatically. A new PR comment with `@codex review` on its own line requests another review; **Actions → OpenAI PR review → Run workflow** accepts a PR number as a manual fallback. Linked-Issue updates also refresh the associated open PRs. Results appear on the reviewed commit as `OpenAI PR Review`, `OpenAI Issue Review`, and `OpenAI Code Review`. These checks complement the project's tests and human review; closing Issues are optional.

## License

[MIT](LICENSE)
