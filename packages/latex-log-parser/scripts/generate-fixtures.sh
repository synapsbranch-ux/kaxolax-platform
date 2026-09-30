#!/usr/bin/env bash
# Régénère les logs de test à partir de test/fixtures-src avec la vraie image TeX Live.
# Usage : scripts/generate-fixtures.sh [image]   (défaut : kaxolax-texlive:2026-medium)
set -euo pipefail

image="${1:-kaxolax-texlive:2026-medium}"
root="$(cd "$(dirname "$0")/.." && pwd)"

for source in "$root"/test/fixtures-src/*/; do
  name="$(basename "$source")"
  compiler="$(sed -n 's/.*"compiler": *"\([a-z]*\)".*/\1/p' "$source/fixture.json")"
  flags=(-file-line-error)
  if grep -q '"fileLineError": *false' "$source/fixture.json"; then flags=(); fi
  case "$compiler" in
    pdflatex) engine=-pdf ;;
    xelatex) engine=-xelatex ;;
    lualatex) engine=-lualatex ;;
  esac

  work="$(mktemp -d)"
  cp -R "$source". "$work/"
  rm "$work/fixture.json"
  chmod -R a+rwX "$work"
  docker run --rm --network none --user 1000:1000 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
    --tmpfs /tmp/biber:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,source=$work,target=/compile" --workdir /compile \
    "$image" latexmk -norc -cd -f -jobname=output -synctex=1 -interaction=batchmode \
    "${flags[@]}" "$engine" main.tex >/dev/null 2>&1 || true

  target="$root/test/fixtures/$name"
  mkdir -p "$target"
  cp "$work/output.log" "$target/output.log"
  if [[ -f "$work/output.blg" ]]; then cp "$work/output.blg" "$target/output.blg"; fi
  rm -rf "$work"
  echo "$name: $(wc -c <"$target/output.log") bytes"
done
