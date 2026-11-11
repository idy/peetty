---
version: 1
slug: "src-chat-panel-ts"
primary_target: "src/chat/panel.ts"
related_targets: ["src/chat/view.ts","src/chat/management.ts","src/figure/portrait.ts"]
---

## Surface
Popup chat/config dialog (chat, connection setup, Profile / Memory / History / Data management). Mode: Operate. Floating window beside the pet, embedded on arbitrary sites, light and dark, system fonts only, no external assets.

## Audience and task
People who keep an anime desk-pet companion on websites they use. They chat in short turns, occasionally open settings to switch Profiles, correct memories, review history, back up. The exchange-diary notebook look was rejected by the user as ugly; they asked for an unmistakably anime (二次元) look.

## Direction contract
THESIS: The popup is the character's own in-game messenger (角色通讯), the kind an anime game gives each character. The character is on screen; the window borrows the host page’s accent, with the character image colour (印象色) as fallback. The notebook world is the anti-reference: no ruled paper, no cover bands, no muted stationery colours.
OWN-WORLD: Bright, saturated, rounded. A two-stop image-colour gradient header with manga screentone dots and slanted speed stripes; the character's live portrait (drawn from her own rig, changing expression while she thinks and talks) in a white-ringed circle. Speech bubbles with a small tail corner: hers white with her avatar and name, yours filled in her colour. Pill buttons and tabs, rounded display type, four-point sparkles as the one ornament. Dark mode is a tinted night sky, not grey.
STORY: You see who you are talking to (her face, her colour, her name), read her bubbles, answer in yours, and in settings manage her card: profile, memories as sparkle-marked lines, history, connection, data.
FIRST VIEWPORT: Gradient header with portrait, name, model status pill, settings and close. Bubble conversation. Rounded composer with a round send button in her colour. Empty state: her large portrait and a greeting.
FORM: Anime game character messenger, code-led and directed by the user's explicit replacement request ("二次元风格"). Provenance: no new concept roll; the former seed:1e6946b5e0bf1480 belongs to the rejected diary direction and does not authorize this replacement. The user approved the gradient and requested page-adaptive colour: host theme and visible control colours choose the gradient family first; hand-mapped characters, custom palettes and deterministic id colours provide fallbacks. Signature move: the portrait reacts with thinking and talking expressions while a reply is produced.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
