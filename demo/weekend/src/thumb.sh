#!/bin/bash
# thumb.sh <in.jpg> <out.jpg> — 320px-wide JPEG thumbnail via sips (macOS). Input should already be
# the blurred, metadata-free image from blur.swift; the thumbnail is derived from it.
set -euo pipefail
if [ $# -ne 2 ]; then echo "usage: thumb.sh <in.jpg> <out.jpg>" >&2; exit 2; fi
in="$1"; out="$2"
[ -f "$in" ] || { echo "thumb.sh: no such file: $in" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
sips --resampleWidth 320 -s format jpeg -s formatOptions 80 "$in" --out "$out" >/dev/null
