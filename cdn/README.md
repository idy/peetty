# Peetty browser distribution

Generated for v0.4.0 by `npm run build:cdn`. Commit this directory together with its source before tagging a release. jsDelivr serves these files directly from GitHub; no npm installation or registry authentication is needed.

- ES module: https://cdn.jsdelivr.net/gh/idy/peetty@v0.4.0/cdn/index.js
- Classic script: https://cdn.jsdelivr.net/gh/idy/peetty@v0.4.0/cdn/peetty.global.js

Keep `chat/` and `chunks/` adjacent to the entry points. Figure JSON lives in the sibling `figures/` directory at the repository root. Both browser entries retain their own CDN host and version when loading these resources. No separate CSS file is required. Preserve `THIRD_PARTY_NOTICES.txt` when redistributing these files; it contains the licenses and notices for bundled dependencies. Per-file license comments are also retained.

These URLs become available only after the corresponding GitHub tag is pushed. Do not edit generated files by hand.
