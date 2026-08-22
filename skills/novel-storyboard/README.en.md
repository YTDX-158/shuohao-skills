**English** · [中文](README.md)

# novel-storyboard

Storyboard for AI short drama (Seedance one-shot-one-video edition): cut the beat stream from novel-script into generation task cards for Seedance. This is the first layer that talks directly to the video model. Core assumption: **one shot = one video, each shot generated independently with a fixed duration**.

```
episode
 └─ segment = optional grouping, ≤15s emotional-arc unit, never crosses scenes
     └─ shot × 2–4 = one independent generation each, fixed 1–6s (hard gate), claims script beats
         ├─ structured metadata: space / pose / position / mood (@setting-image bindings)
         ├─ visual description (shotDesc): one primary camera move + light + micro-action + time
         ├─ dialogue: @speaker says in Chinese [tone] <line> (verbatim, original language)
         └─ no-subtitle constraint
```

- **One image + one prompt per shot** — storyboard image `frame` (for Seedream reference) + `seedancePrompt` (assembled by render, sent straight to Seedance), generated independently
- **@binding = setting image** — `@老张` `@蒲扇` are uploaded setting images (character/prop); plus scene image (`sceneImage`, outside the prompt). Full reference; text only handles composition/action/mood
- **Fixed duration is written dead** — `c01,4s` in the shot line IS the generation parameter; dialogue seconds (÷5.5) must fit; long lines split shots first

Outputs `storyboard.json` + Markdown + a double-click-openable `storyboard-report.html`.

## Quality gates: 16 (+ optional 17th), all code

Same stance as the other four skills in this repo: **a checklist left to model self-discipline is unreliable**.

| Gate | Rule |
| --- | --- |
| Beat coverage | every script beat claimed by exactly one shot, in order, contiguous, no scene crossing |
| Segment duration | Σ shot seconds ≤ 15 (grouping cap) |
| **Shot duration** | 1–6s fixed per shot — hard gate; reaction shots may be 1s |
| Dialogue fits | claimed dialogue seconds (÷5.5, mood coefficient) ≤ shot seconds |
| Per-episode total | Σ segments within `targetSeconds` ±15% |
| On-screen cap | ≤3 people per shot, else a breakdown note is required |
| Segment id | `E01-01` format, sequential |
| Size phrase | `close-up` etc. must appear in the storyboard-image prompt |
| Camera vocabulary | Seedance terms (`Push In` / `Tracking`…), in the shot's own description |
| **Fixed duration + segment sum** | shot `seconds` matches the `seedancePrompt` shot line verbatim; segment = Σ shots |
| **Dialogue verbatim** | `@speaker says in Chinese [tone] <line>` — original language, not one punctuation off |
| **No text** | every `seedancePrompt` carries "no visible subtitles/text" |
| **Style phrase** | `style` preset (e.g. 写实向半厚涂) appears in every storyboard-image prompt |
| Image-prompt hygiene | full English, non-empty |
| No character names | in storyboard-image prompts |
| **@binding ↔ assets** | every `@X` in metadata ∈ asset library (character/prop setting-image names) |
| Reference check | scene/character/prop all reconcile with the script scene |
| Shot recipe (opt 17th) | checked only when `--shots` is given (same logic as before) |

Each gate has a break-case in the self-test — proving it actually blocks.

**Shot recipe is an optional vocabulary layer**: a `recipe` id may sit on a shot. No shot-recipes → still runs fine, self-contained. The card's **suggested size/camera are deliberately not gated** — recipe is vocabulary, not law; **a wrongly-firing gate is worse than no gate**.

## Gate failures accumulate — `stats` tells you the most-violated rule

`validate` and `checkup` append gate results to `.gates.jsonl` in the current directory. After dozens of runs:

```bash
node scripts/novel-storyboard.mjs stats
```

Answers three questions: which gate fires most (fix the rule wording, don't scold the model) · which never fires (dead gate / already internalized) · what failures look like. Add `--no-log` to opt out.

## Report

1600px single-page review report:

- **KPI band**: segments / shot count & avg seconds / total vs target / batches / dialogue blocks
- **Shot rhythm band** (signature): one colored strip per episode, **thick separators = segment boundaries (emotional-arc groups)**, bar width = shot share, color depth = shot-size proximity
- **Per-episode storyboard table**: one card per segment — storyboard image 16:9 (placeholder if missing, never fake) + split pane: left shot rows (`c01,4s` · size · camera · **structured-metadata chips: space/pose/position/mood** · summary from claimed beats), right **seedancePrompt panel** (monospace, one-click copy)
- **Batch sheet**: shots with same scene + lighting grouped, sharing one environment reference image
- **Dialogue alignment sheet**: every line mapped to segment#shot
- **Quality gates** panel + header badge + **export JSON** (raw `storyboard.json`)
- All inline CSS/SVG, zero external deps, opens offline

## Five-skill relay (pipeline closes here)

```
novel-outline    → outline.json    (what: structure & episodes)
novel-characters → cast.json       (who: character setting images)
novel-art        → art.json        (where: scene/prop setting images)
novel-script     → script.json     (drama: scenes, beats, lines)
novel-storyboard → storyboard.json (how: shots, metadata, prompts, batches)
```

- `seed <script.json> --eps 1-3` deterministically expands per-scene beat lists (number, per-beat seconds, speaker) as the cutting draft — **per-beat seconds are computed (÷5.5), not re-estimated by the model**
- `validate --script` is a hard prerequisite; `--outline`/`--cast` check prompt names (@binding whitelist); `--art` shows scene names in report & embeds setting images in batch sheet
- Storyboard images come from an image model with scene/character/prop setting images as references; `seedancePrompt` + the image set go straight to Seedance

## CLI

```bash
node scripts/novel-storyboard.mjs seed script.json --eps 1
node scripts/novel-storyboard.mjs validate sb.json \
     --script script.json --outline outline.json --cast cast.json
node scripts/novel-storyboard.mjs checkup sb.json --script script.json
node scripts/novel-storyboard.mjs validate sb.json --script script.json \
     --shots ../shot-recipes/references/cards
node scripts/novel-storyboard.mjs render sb.json --html \
     --script script.json --outline outline.json --art art.json > storyboard-report.html
node scripts/novel-storyboard.mjs export sb.json --script script.json
```

`export` fixed structure: **one folder per segment** `E01-01/` — storyboard images `f1..fN.png` + `prompt.md` (one `seedancePrompt` per shot), `manifest.json` at root with image list and missing-image notes. One segment folder = all materials for one-shot-one-video.

## Files

```
SKILL.md                 workflow for the agent
scripts/
  novel-storyboard.mjs   seed / validate / checkup / render / export / slug
  selftest.mjs           240+ assertions, no model
references/
  schema.md              storyboard.json structure + duration chain
  seedance-prompt.md     Seedance per-shot prompt spec + cinematography reference
  storyboard-pass.md     cutting: grouping, duration method, director's feel, pitfalls
  frame.md               storyboard-image call contract
  report-style.md        report design conventions
examples/
  渡口-storyboard.json   《渡口》ep1 full storyboard (new schema), all gates pass; also the self-test fixture
```

## Self-test

```bash
node scripts/selftest.mjs
```

240+ assertions covering beat expansion / metadata reconciliation / stats & batches / per-gate break-cases / recipe parsing & mount / seed / rendering (zh+en UI) / export. No model, no quota, ~1s. Run this after every script change.

**Upstream verified on macOS + Node 24; YTDX fork verified on Win11 + Node 24.**
