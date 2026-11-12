#!/usr/bin/env python3
"""Resize generated demo renders and emit the base64 files the app ships.

The repository commits images as <name>.jpg.b64 (text) so they survive the
GitHub API's binary-file limits; scripts/prepare-assets.js decodes them back to
real .jpg files on every deploy. This helper is the encoder half of the demo
catalogue generator.

Usage:
  python3 scripts/encode-demo-images.py --src assets-src/demo --out public/demo

Expected input layout:
  <src>/products/<slug>.png   (1024px renders, any square-ish size)
  <src>/sellers/<slug>.png
  <src>/banners/<slug>.png    (wide storefront renders)
"""
import argparse
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is required for image encoding: pip install pillow")


def encode(src_file: Path, out_file: Path, width: int, height: int, quality: int) -> None:
    im = Image.open(src_file).convert("RGB")
    im = ImageOps.fit(im, (width, height), Image.LANCZOS, centering=(0.5, 0.45))
    tmp = out_file.with_suffix(".jpg")
    im.save(tmp, "JPEG", quality=quality, optimize=True, progressive=True)
    data = tmp.read_bytes()
    out_file.write_text(__import__("base64").b64encode(data).decode("ascii"), encoding="ascii")
    tmp.unlink(missing_ok=True)
    print(f"  encoded {out_file.relative_to(out_file.parents[2])} ({len(data) // 1024} KB jpeg)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="folder holding products/ and sellers/ renders")
    ap.add_argument("--out", required=True, help="public/demo output folder")
    args = ap.parse_args()

    src, out = Path(args.src), Path(args.out)
    jobs = [("products", 560, 560, 82), ("sellers", 320, 320, 85), ("banners", 1200, 400, 82)]
    missing = 0
    for folder, width, height, quality in jobs:
        src_dir, out_dir = src / folder, out / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        if not src_dir.is_dir():
            print(f"  [warn] no source folder {src_dir} — keeping existing .b64 files")
            continue
        files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
        for f in files:
            encode(f, out_dir / (f.stem + ".jpg.b64"), width, height, quality)
        missing += 0
        print(f"  {folder}: {len(files)} image(s)")
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
