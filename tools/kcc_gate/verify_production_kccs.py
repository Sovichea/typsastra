#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

from PIL import Image, ImageStat

FONT_EXT = {".ttf", ".otf", ".ttc", ".otc"}
PROBE_FAMILIES = ["Khmer Kampot", "Khmer Victorya Treykrim", "Kh Preyveng"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scalar_key(text: str):
    return tuple(ord(ch) for ch in text)


def load_candidates(path: Path) -> list[str]:
    encoded = "".join(path.read_text(encoding="utf-8").split())
    raw = gzip.decompress(base64.b64decode(encoded))
    tokens = [line for line in raw.decode("utf-8").splitlines() if line]
    if len(tokens) != len(set(tokens)):
        raise SystemExit("duplicate candidate tokens")
    return sorted(tokens, key=scalar_key)


def extract_fonts(archive: Path, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    seen = set()
    count = 0
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            p = Path(info.filename)
            if p.is_absolute() or ".." in p.parts or p.suffix.lower() not in FONT_EXT:
                continue
            data = zf.read(info)
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            (out / f"{digest[:20]}{p.suffix.lower()}").write_bytes(data)
            count += 1
    return count


def typst_quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def visible(path: Path) -> bool:
    with Image.open(path) as image:
        gray = image.convert("L")
        lo, _ = ImageStat.Stat(gray).extrema[0]
        return gray.width > 2 and gray.height > 2 and lo < 230


def render_family(typst: Path, font_pool: Path, family: str, tokens: list[str], batch_size: int = 256):
    ok = set()
    failures = []
    for start in range(0, len(tokens), batch_size):
        batch = tokens[start:start + batch_size]
        with tempfile.TemporaryDirectory(prefix="production-kcc-gate-") as td:
            td = Path(td)
            source = (
                '#set page(width: auto, height: auto, margin: 5pt, fill: white)\n'
                f'#set text(font: {typst_quote(family)}, fallback: false, size: 42pt, fill: black)\n'
            )
            source += "\n#pagebreak()\n".join(f"#text({typst_quote(token)})" for token in batch) + "\n"
            typ = td / "batch.typ"
            typ.write_text(source, encoding="utf-8")
            pattern = td / "page-{0p}.png"
            cp = subprocess.run(
                [
                    str(typst), "compile", str(typ), str(pattern),
                    "--ppi", "144",
                    "--font-path", str(font_pool),
                    "--ignore-system-fonts",
                    "--ignore-embedded-fonts",
                    "--jobs", "1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            pages = sorted(td.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
            if cp.returncode != 0 or len(pages) != len(batch):
                for token in batch:
                    failures.append({
                        "token": token,
                        "family": family,
                        "reason": "compile_batch",
                        "returncode": cp.returncode,
                        "pages": len(pages),
                        "expected_pages": len(batch),
                        "stderr": cp.stderr[-1600:],
                    })
            else:
                for token, page in zip(batch, pages):
                    if visible(page):
                        ok.add(token)
                    else:
                        failures.append({"token": token, "family": family, "reason": "no_visible_ink"})
        print(f"{family}: {min(start + batch_size, len(tokens))}/{len(tokens)}")
    return ok, failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--typst", type=Path, required=True)
    ap.add_argument("--fonts", type=Path, required=True)
    ap.add_argument("--candidates-b64", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    candidates = load_candidates(args.candidates_b64)
    if len(candidates) != 1062:
        raise SystemExit(f"expected 1062 production candidates, got {len(candidates)}")

    pool = args.out / "font_pool"
    extracted = extract_fonts(args.fonts, pool)
    successes = Counter()
    failures = []

    for family in PROBE_FAMILIES:
        ok, fail = render_family(args.typst, pool, family, candidates)
        for token in ok:
            successes[token] += 1
        failures.extend(fail)

    required = 2
    verified = [t for t in candidates if successes[t] >= required]
    rejected = [t for t in candidates if successes[t] < required]

    (args.out / "verified.txt").write_text("\n".join(verified) + ("\n" if verified else ""), encoding="utf-8")
    (args.out / "rejected.txt").write_text("\n".join(rejected) + ("\n" if rejected else ""), encoding="utf-8")
    with (args.out / "verification.jsonl").open("w", encoding="utf-8") as f:
        for token in candidates:
            f.write(json.dumps({
                "token": token,
                "successes": successes[token],
                "required": required,
                "verified": successes[token] >= required,
                "codepoints": [f"U+{ord(ch):04X}" for ch in token],
            }, ensure_ascii=False) + "\n")
    with (args.out / "failures.jsonl").open("w", encoding="utf-8") as f:
        for row in failures:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    version = subprocess.run([str(args.typst), "--version"], stdout=subprocess.PIPE, text=True).stdout.strip()
    summary = {
        "renderer_version": version,
        "renderer_sha256": sha256(args.typst),
        "font_archive_sha256": sha256(args.fonts),
        "font_files_extracted": extracted,
        "candidate_count": len(candidates),
        "verified_count": len(verified),
        "rejected_count": len(rejected),
        "probe_families": PROBE_FAMILIES,
        "required_successes": required,
        "selection_uses_only_previous_train_probe_families": True,
        "unicode_normalization": "none",
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if rejected:
        raise SystemExit(f"{len(rejected)} production KCCs failed the render gate")


if __name__ == "__main__":
    main()
