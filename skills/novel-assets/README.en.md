**English** · [中文](README.md)

# novel-assets

**Stage 6 of the AI short-drama pipeline: the image-generation loop.**

The first five stages already wrote every prompt — `image.sheet` for characters/scenes/props and `frame` for each storyboard shot. novel-assets writes no prompts of its own. It does three things:

1. **Package**: packs the existing prompts into an "image-pack zip" (sent wholesale to GPT)
2. **Place**: moves the returned images into `images/` and `<segment>/` folders by naming rules
3. **Render**: regenerates reports so the images show up

## Why GPT instead of local generation

Images are generated in **GPT Image 2 (user's Plus account, web UI)** — stronger at multi-view layout and character consistency than local Seedream, and uses subscription quota (no API billing). Claude can't do this step itself. **The user only acts twice: drop the zip in, drop the zip back** — GPT completes everything on its own:

```
Claude produces image-pack zip → user drops it to GPT → GPT reads 说明.txt and
does it all (setting sheets → remembers → storyboard frames → zips the delivery)
→ user returns delivery zip → Claude places → Claude renders reports → ✅
```

## Commands

```bash
# ① produce the "image-pack zip" (send wholesale to GPT; needs python zipfile)
node scripts/novel-assets.mjs run <title> \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  --ratio 9:16 --style "dark realistic" --out <dir>
# optional: --style-ref <local image>  (style reference → packed as style-ref.png; GPT told to
#                                       copy only look/lighting/material, never the character face)
#           --negative "avoid anime"   (negative prompt → written into 说明.txt; GPT web UI has no field)

# ⑤ place images from the unzipped delivery
node scripts/novel-assets.mjs place <unzip-dir> --out <project-dir>

# ⑥ re-render reports
node scripts/novel-assets.mjs render \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  --cast-script <novel-characters.mjs> --art-script <novel-art.mjs> --sb-script <novel-storyboard.mjs>
```

## What's inside the image-pack zip

| File | Content | Ratio |
|------|---------|-------|
| `说明.txt` | GPT's master instructions: unify style → setting sheets → remember → storyboard frames → zip delivery | — |
| `01_设定图提示词.txt` | 16 setting sheets (10 characters + 3 scenes + 3 props), each `image.sheet` + naming | per sheet (16:9 asset) |
| `02_分镜图提示词.txt` | 36 storyboard frames, each with "reference setting sheet" binding + `frame` + naming | **9:16** (matches video) |
| `style-ref.png` | **Optional** (only with `--style-ref`): the style reference image, used once as a style anchor in the sheet stage | — |

## Naming rules (place follows these)

- Setting sheet: `林风-sheet.png` → `images/林风-sheet.png`
- Storyboard frame: `E01-01_f1.png` → `E01-01/f1.png` (per-segment count from 1, no leading zero)

## Boundaries

- No prompt writing, no image generation (GPT web UI), no API, no JSON modification.
- **Needs python** for zip packing (zipfile, stdlib; UTF-8 filename flag against CJK mojibake).
- The codex-based paths in `sheet.md`/`frame.md` remain as reference; novel-assets is the primary path.
