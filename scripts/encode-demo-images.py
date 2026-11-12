#!/usr/bin/env python3
"""Resize generated demo renders and emit the base64 files the app ships.

The repository commits images as <name>.jpg.b64 (text) so they survive the
GitHub API's binary-file limits; scripts/prepare-assets.js decodes them back to
real .jpg files on every deploy. This helper is the encoder half of the demo
catalogue generator.

Usage:
  python3 scripts/encode-demo-images.py --src assets-src/demo --out public/demo \
      --source catalog/demo-catalog.source.json

Expected input layout:
  <src>/products/<slug>.png   (1024px renders, any square-ish size)
  <src>/sellers/<slug>.png
  <src>/banners/<slug>.png    (wide storefront renders)

Product models listed in the source catalogue are always encoded. A model with
no render of its own may declare `deriveFrom` + `derive` (flip / crop / grade),
in which case a distinct shot is derived from the base render so every product
still ships a real photo.
"""
import argparse
import base64
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageEnhance, ImageOps
except ImportError:
    sys.exit("Pillow is required for image encoding: pip install pillow")


def grade(im: Image.Image, kind: str) -> Image.Image:
    r, g, b = im.split()
    if kind == "warm":
        r = r.point(lambda v: min(255, int(v * 1.06) + 3))
        b = b.point(lambda v: max(0, int(v * 0.96)))
    elif kind == "cool":
        b = b.point(lambda v: min(255, int(v * 1.06) + 3))
        r = r.point(lambda v: max(0, int(v * 0.96)))
    im = Image.merge("RGB", (r, g, b))
    return ImageEnhance.Color(im).enhance(1.04)


def derive(base: Image.Image, opts: dict) -> Image.Image:
    im = base
    if opts.get("flip"):
        im = ImageOps.mirror(im)
    crop = float(opts.get("crop") or 1.0)
    if crop > 1.0:
        w, h = im.size
        nw, nh = int(w / crop), int(h / crop)
        im = im.crop(((w - nw) // 2, (h - nh) // 2, (w + nw) // 2, (h + nh) // 2))
    if opts.get("grade"):
        im = grade(im, opts["grade"])
    return im


def encode(im: Image.Image, out_file: Path, width: int, height: int, quality: int) -> int:
    im = ImageOps.fit(im, (width, height), Image.LANCZOS, centering=(0.5, 0.45))
    tmp = out_file.with_suffix(".jpg")
    im.save(tmp, "JPEG", quality=quality, optimize=True, progressive=True)
    data = tmp.read_bytes()
    out_file.write_text(base64.b64encode(data).decode("ascii"), encoding="ascii")
    tmp.unlink(missing_ok=True)
    print(f"  encoded {out_file.relative_to(out_file.parents[2])} ({len(data) // 1024} KB jpeg)")
    return len(data)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="folder holding products/, sellers/ and banners/ renders")
    ap.add_argument("--out", required=True, help="public/demo output folder")
    ap.add_argument("--source", default="catalog/demo-catalog.source.json", help="catalogue source JSON")
    args = ap.parse_args()

    src, out = Path(args.src), Path(args.out)
    out.joinpath("products").mkdir(parents=True, exist_ok=True)

    products_src = src / "products"
    models = []
    source_path = Path(args.source)
    if source_path.exists():
        data = json.loads(source_path.read_text(encoding="utf-8"))
        models = (data.get("models") or []) + (data.get("extraModels") or [])
    if not models:
        print("  [warn] no catalogue models found — falling back to the products folder")
        models = [{"slug": p.stem} for p in products_src.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")]

    made = 0
    for model in models:
        slug = model["slug"]
        out_file = out / "products" / (slug + ".jpg.b64")
        exact = None
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            candidate = products_src / (slug + ext)
            if candidate.exists():
                exact = candidate
                break
        try:
            if exact:
                im = Image.open(exact).convert("RGB")
            elif model.get("deriveFrom"):
                base = None
                for ext in (".png", ".jpg", ".jpeg", ".webp"):
                    candidate = products_src / (model["deriveFrom"] + ext)
                    if candidate.exists():
                        base = candidate
                        break
                if not base:
                    print(f"  [warn] no render for {slug} (base {model['deriveFrom']} missing)")
                    continue
                im = derive(Image.open(base).convert("RGB"), model.get("derive") or {})
            else:
                print(f"  [warn] no render for {slug}")
                continue
            encode(im, out_file, 560, 560, 82)
            made += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] failed {slug}: {exc}")
    print(f"  products: {made}/{len(models)} image(s)")

    for folder, width, height, quality in (("sellers", 320, 320, 85), ("banners", 1000, 333, 78)):
        src_dir, out_dir = src / folder, out / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        if not src_dir.is_dir():
            print(f"  [warn] no source folder {src_dir} — keeping existing .b64 files")
            continue
        files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
        for f in files:
            encode(Image.open(f).convert("RGB"), out_dir / (f.stem + ".jpg.b64"), width, height, quality)
        print(f"  {folder}: {len(files)} image(s)")


if __name__ == "__main__":
    main()
