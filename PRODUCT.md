# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Peetty is a browser companion with selectable characters and conversations through the user's own model connection. It runs on arbitrary websites through the SDK and on a static hosted website.

## Capabilities and Constraints

- Keep the browser-only architecture: static hosting, browser-direct model requests, no local relay or project backend.
- A Profile is an independent companion archive, with its own character, personality, model connection, memories and conversation history. Choosing the same character does not share data between Profiles.
- Settings must let the user create and switch Profiles, inspect and edit memories and history, and change character and personality.
- Complete downloadable backups include every Profile, memory, history entry, Provider endpoint, model configuration and API key. Saved connections and session overrides are retained separately, preserving their credential lifetime on restore. Restore imports independent Profiles without overwriting existing ones; a verified unused bootstrap placeholder can be replaced for a full-capacity first restore.
- Current limits: backup/import files are capped at 50 MiB, while accumulated local data may exceed that export ceiling. History remains in a single IndexedDB record per Profile; splitting persistence and multipart migration are unresolved architecture and capacity-policy decisions.
- Memory-only import and export are separate from complete backup and restore.
- Data stays in this website's browser storage. Cross-site and cross-device migration uses downloaded backups; automatic cross-site sharing is outside this feature.

## Product Principles

- Make remembered information inspectable and correctable.
- Keep Profiles independent through asynchronous model requests and storage operations.
- Preserve existing data during migration and restore.
- Make backups sufficient to move the companion and its connection to another deployment.
