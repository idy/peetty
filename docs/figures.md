# Figure packs

A Peetty figure is a JSON file: shapes, colors and a few motion hints. The SDK owns the animation, so a figure only has to draw its parts and attach them to a standard skeleton. Any figure can be recolored by overriding its palette.

Add `"$schema": "https://peetty.idy.dev/schema/figure-v1.json"` for editor completion. The schema ships in the package as `@idy/peetty/schema/figure-v1.json`; the SDK's `validateFigure()` is authoritative and also checks cross-references and size limits.

## Presets

| ID | Character | Personality in motion |
| --- | --- | --- |
| `miru` | Lavender-to-mist-blue twin tails, cursor hair clip, bows with browser-tab loops, white hoodie | Quick and bouncy; walks, hops and waves more often |
| `koharu` | From Japan. Peach-coral bob, cat-ear beret, star pin, sailor-collar dress | Drowsy; naps often and stretches with a yawn |
| `xiaoxiao` | From China. Black double buns with red cords and tassels, rose-red top with frog buttons | Quick and cheerful; holds a cup of milk tea and sips it |
| `riley` | From the US. Chestnut ponytail, varsity jacket, denim skirt, sneakers | Outgoing; jumps the highest and blows bubble gum |
| `amara` | From the US. Two curly afro puffs, curly fringe, coral pinafore, lilac high-tops | Curious; holds a camera and snaps photos now and then |
| `elsie` | From the UK. Honey-blonde bob, freckles, duffle coat, tartan scarf | Polite and calm; sips tea, floats down under her umbrella |

These six are bundled into the SDK. `shiori` (silver side braid, a tiny book, reads while idle) is in the catalog and loads on demand.

The presets are original characters, licensed CC BY 4.0 so they can be used as starting points. Their sources are `figures/src/<id>.mjs`, written with the drawing helpers in `figures/src/kit.mjs`; `npm run figures` validates them and writes `figures/<id>.json`.

## Loading a figure

The `figure` option (or `data-figure` on the script tag) accepts:

| Value | Loads |
| --- | --- |
| `miru`, `shiori`, `koharu` | The bundled preset, with no request |
| Any other id, e.g. `xiaoxiao` | `https://peetty.idy.dev/figures/<id>.json` from the public catalog |
| A URL or relative path | That figure JSON file, e.g. `https://example.com/my-pet.json` or `/pets/mimi.json` |
| An object | Figure data passed in directly |

Every loaded figure is validated first. A figure on another site must be served with CORS (`Access-Control-Allow-Origin`); GitHub Pages, including peetty.idy.dev, does this. `listFigures()` returns the catalog entries from `figures/index.json`, for building a character picker.

## The catalog and contributing a figure

`figures/` is the catalog: one `<id>.json` per figure, plus `index.json`, which `npm run figures` generates with each figure's id, name, description, author, license and public URL. The website publishes the whole directory at `https://peetty.idy.dev/figures/`. Only the presets are bundled into the SDK; the rest load on demand, so the catalog can grow without making the script larger.

To contribute a figure:

1. Pick an unused id (lowercase letters, digits and hyphens) and name the file `figures/<id>.json`. If you build it with the drawing kit, put the source in `figures/src/<id>.mjs` instead and let `npm run figures` write the JSON.
2. Set `author` and an SPDX `license`. The artwork must be your own original work or properly licensed; characters from existing games, anime or other franchises cannot be accepted.
3. Run `npm run figures`, `npm test` and `npm run check`, and look at it in the figure sheet (`npm run dev`, then `/dev/figures.html?figures=<id>`; the sheet uses the source if there is one, otherwise `figures/<id>.json`).
4. Open a pull request. CI validates every figure and checks that `index.json` is current.

## Format

```jsonc
{
  "format": "peetty.figure",
  "version": 1,
  "id": "my-figure",                       // 1–40 lowercase letters, digits, hyphens
  "name": { "en": "Mimi", "zh": "米米" },   // or a plain string
  "author": "you", "license": "CC-BY-4.0",
  "renderer": "rig",                       // or "sprite"
  "viewBox": [0, 0, 200, 260],             // drawing coordinates
  "height": 120,                           // CSS pixels at scale 1
  "anchor": [100, 256],                    // the point that stands on an edge
  "palette": { "hair": "#cfbaf7", "skin": "#fff3ec" },
  "behavior": { "weights": { "sit": 3 }, "walkSpeed": 1, "jumpPower": 1, "idleProp": "none" },
  "skeleton": { "root": { "pivot": [100, 256] }, "hips": { "pivot": [100, 198] } /* … every bone */ },
  "gradients": { "hairGrad": { "type": "linear", "from": [0, 18], "to": [0, 204], "stops": [{ "offset": 0, "color": "hair" }] } },
  "clips": { "eyeL": [{ "type": "path", "d": "M…Z" }] },
  "parts": [
    { "id": "tailL", "bone": "head", "z": 6, "pivot": [56, 58],
      "spring": { "stiffness": 0.07, "damping": 0.88, "gain": 1.3, "limit": 16, "hang": 0.75 },
      "shapes": [{ "type": "path", "d": "M58 51C…Z", "fill": "hairGrad", "stroke": "hairLine", "strokeWidth": 1.2 }] }
  ]
}
```

### Skeleton

Bones and parents: `root` → `hips` → `legL`, `legR`, `body` → `head`, `armL`, `armR`. `L` and `R` are the viewer's left and right. Give each bone a pivot in viewBox coordinates: the hip joint, the neck, the shoulders and so on. Parts drawn on a bone move with it.

### Parts

| Field | Meaning |
| --- | --- |
| `bone` | Which bone the part follows |
| `z` | Draw order across the whole figure, so back hair can sit behind the body while the face sits in front |
| `shapes` | `path` (SVG path data) or `ellipse`, each with `fill`, `stroke`, `strokeWidth`, `opacity`, `lineCap`, `lineJoin` and `blend` (`multiply`, `screen`, `overlay`) |
| `slot` | Show the part only in one expression state, e.g. `eyes:closed` |
| `spring` + `pivot` | Secondary motion for hair, ribbons and skirts: the part lags behind, swings and settles |
| `look` | Maximum `[x, y]` offset while following the pointer, for irises |
| `clip` | Clip key, e.g. keep an iris inside its eye; the clip does not move with `look` |

Paint values are palette keys, gradient keys or literal colors (`#hex`, `rgb()`, `hsl()`, `none`).

### Expression slots

| Slot | States, first is the default |
| --- | --- |
| `eyes` | `open`, `closed`, `happy`, `sleepy` |
| `mouth` | `smile`, `open`, `talk`, `flat`, `o` |
| `brows` | `calm`, `worried` |
| `hand` | `rest`, `book`, `cup`, `camera`, `umbrella` |
| `armL`, `armR` | `rest`, `bent`, `up`, `fold` |

Arms are never bent at runtime. Draw each arm pose whole (hanging, forearm across the front, raised to the side, folded flat for lying or clinging to an edge); the arm bone only rotates the drawing a little, around a round shoulder so no gap opens. `figures/src/kit.mjs` has an `arms()` helper that draws all four from sleeve colours. A missing pose falls back to the slot's first state.

Missing states fall back: `happy` and `sleepy` eyes use `closed`, then `open`; `talk` and `o` mouths use `open`, then `smile`. A figure needs only `eyes:open` and `mouth:smile` to work, but blinking needs `eyes:closed`.

### Animation states

The SDK animates `idle`, `walk`, `jump`, `fall`, `sit`, `lie`, `hang`, `sleep`, `drag`, `wave`, `talk` and `think` for every rig figure, with breathing and sway underneath, anticipation before jumps, squash on landing, natural blinking and pointer-following eyes. `behavior.weights` biases the autonomous choices `idle`, `walk`, `jump`, `sit`, `lie`, `sleep`, `think`, `wave` and `talk`; falling, hanging and dragging follow physical interactions instead of weights. `walkSpeed` also sets the figure's tempo. `idleProp` adds a personal idle: `"book"`, `"cup"` and `"camera"` hold a prop in both hands (draw `hand:book`, `hand:cup` or `hand:camera`), `"gum"` blows a bubble until it pops (draw `mouth:gum` and `mouth:gumBig`; `gum()` in the kit draws both), and `"stretch"` adds an occasional stretch and yawn. `fallProp: "umbrella"` makes her float down slowly under an umbrella (draw `hand:umbrella`).

A fall frightens her: the SDK draws her soul drifting out of her mouth and hides the irises (the parts with `look`), so her eyes go blank, then lets the soul slip back in shortly after she lands. Dropping in, floating under an umbrella and the way up after a throw stay calm. Nothing needs to be drawn for this; the soul's tail ends just above the `head` pivot, where the presets draw the mouth.

### Action sounds

The optional `sounds` field belongs to each figure. Presets include quiet synthesized cues with their own pitches and rhythms; they work offline without audio downloads. Older figures without `sounds` stay silent.

```json
{
  "sounds": {
    "volume": 0.35,
    "cooldown": 0.6,
    "events": {
      "wave": [
        { "notes": [659, 880, 988], "duration": 0.08, "waveform": "sine" },
        { "notes": [784, 988], "duration": 0.09, "volume": 0.8 }
      ],
      "jump": [{ "notes": [330, 660], "duration": 0.06, "waveform": "triangle" }],
      "land": [{ "src": "./sounds/soft-landing.ogg", "volume": 0.6, "playbackRate": 1 }],
      "sleep": [{ "src": "https://example.com/sounds/sleep.mp3" }]
    }
  }
}
```

Events are the animation states (`idle`, `walk`, `jump`, `fall`, `sit`, `lie`, `hang`, `sleep`, `drag`, `wave`, `talk`, `think`), plus `land` and `wake`. State sounds play once on entry, not on every frame or loop. A configured `land` cue takes priority over the `idle` entry cue; when `land` is absent, landing uses `idle` if configured. `wake` replaces the next state's cue when leaving sleep. Omitted events stay silent. Each event accepts 1–8 alternatives, chosen randomly. `cooldown` sets the minimum seconds between repeats of one event (0–60, default 0.6); a brief global gap also prevents bursts. Playback is one cue at a time.

Use exactly one of `notes` or `src` per cue:

- `notes`: 1–8 frequencies from 80 to 4000 Hz. `duration` is seconds per note (0.03–1, default 0.08); the whole cue must fit within 5 seconds. `waveform` is `sine` (default), `triangle`, or `square`.
- `src`: an HTTP(S) audio URL or relative path. HTTPS pages require HTTPS audio under the browser's mixed-content rules. Relative paths resolve against the loaded figure JSON's final URL; inline figures use the embedding document's base URL. The loader retains the original JSON strings and remembers the asset base separately, so resolving a URL cannot invalidate the drawing. `playbackRate` is 0.5–2 (default 1). Audio must be browser-decodable, served with CORS, no larger than 2 MiB, and no longer than 5 seconds decoded. Files are fetched on demand without cookies or referrers, including ordinary HTTP redirects; slow, unavailable or invalid sounds are skipped.
- `volume`: cue gain from 0–1 (default 1), multiplied by the figure volume (default 0.35) and SDK master volume (default 1).

Pending audio work and decoded PCM cache memory have separate budgets. Canceled native decodes keep their budget until they actually settle; browser decoding itself cannot be aborted, and the five-second duration check happens after decoding. Deterministically invalid assets use a bounded retry backoff, which resets on figure replacement; transient download failures remain retryable.

Sound starts **off**. The companion's menu has a localized Sound toggle; enabling it previews the `wave` cue. You can enable it in the SDK with `createPeetty({ sound: true })` or `sound: { enabled: true, volume: 0.6 }`, or on a script tag with `data-sound="true"`. Browsers still require a user gesture before audio can start; mouse, keyboard, touch/pen release, and gestures inside chat are supported. No sound is queued from before that gesture.

Use `pet.setSound(true)`, `pet.setSound(false)`, or `pet.setSound({ volume: 0.5 })` to update playback; `pet.soundEnabled` reports the setting. Call `pet.previewSound('jump')` inside a button or key handler to audition an event without changing the animation. Muting, hiding, switching figures, leaving the tab, and destroying the companion stop unfinished sounds. Sound settings last for the current instance and are not persisted.

### Sprite figures

`renderer: "sprite"` uses frames from one image instead of parts: `sprite.image` (an `https:` URL or a base64 PNG/WebP/GIF data URL), `frameWidth`, `frameHeight`, `columns`, and `animations` mapping states to `{ "frames": [0, 1, 2], "fps": 8, "loop": true }`. `idle` is required; other states fall back to it. Validation is in place; the sprite renderer is not implemented yet.

## Safety and limits

Figures are data only. The SDK builds SVG elements itself and never parses markup, so path data may contain only path commands and numbers, and colors only color literals. Images must be `https:` or base64 data URLs. A pack may be up to 2,000,000 UTF-8 bytes serialized, with at most 200 parts, 64 shapes per part, 64 palette entries and 64 gradients. Imports report every problem found, with its location.

## Previewing

```bash
npm install
```

```bash
npm run dev
```

Open `http://127.0.0.1:4180/dev/figures.html`. Add `?figures=miru&scale=6` to inspect one figure up close. The sheet loads `figures/src/*.mjs` directly, so edits show on reload.
