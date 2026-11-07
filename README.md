# Peetty

A little companion for the web.

Peetty is an open-source, local-first browser pet. The idea is simple: a small companion that finds a quiet spot on the page, perches on a button or card, and is there when you want to talk.

Bring your own AI API key, shape its personality, and take its memories with you.

> **Status: early planning.** This repository currently contains project documentation only. The capabilities below describe the intended product; no installable extension or application is available yet.

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

## Project direction

The initial target is a browser extension for desktop browsing, with a reusable web core for pet behavior, animation, conversation, and storage. An embeddable web component and a Tauri desktop companion are possible future directions.

Implementation, supported browsers, dependencies, installation, and build instructions will be documented when working code is available.

## Contributing

Ideas, interaction feedback, and technical discussion are welcome in [GitHub Issues](https://github.com/idy/peetty/issues). The first milestone is a small, usable browser companion with thoughtful movement, chat, editable memory, and data portability.

## License

[MIT](LICENSE)
