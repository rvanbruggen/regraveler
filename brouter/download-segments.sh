#!/bin/sh
# Download BRouter routing data tiles (5x5 degree .rd5 files, named after their
# south-west corner) from https://brouter.de/brouter/segments4/.
#
#   download-segments.sh          download missing tiles only (default, used on `docker compose up`)
#   download-segments.sh update   also re-download tiles that changed on the server
set -eu

BASE_URL="${BROUTER_SEGMENTS_URL:-https://brouter.de/brouter/segments4}"
DIR="${SEGMENTS_DIR:-/segments4}"
TILES="${BROUTER_TILES:-E0_N45 E0_N50 E5_N45 E5_N50}"
MODE="${1:-missing}"

mkdir -p "$DIR"
for tile in $TILES; do
  file="$DIR/$tile.rd5"
  tmp="$file.part"
  rm -f "$tmp"
  if [ -s "$file" ]; then
    if [ "$MODE" != "update" ]; then
      echo "$tile.rd5: present"
      continue
    fi
    echo "$tile.rd5: checking for a newer version"
    # -z: only download if the server copy is newer than ours; -R keeps the server timestamp.
    curl -fsSL -R -z "$file" -o "$tmp" "$BASE_URL/$tile.rd5"
  else
    echo "$tile.rd5: downloading (this can take a few minutes)"
    curl -fsSL -R -o "$tmp" "$BASE_URL/$tile.rd5"
  fi
  if [ -s "$tmp" ]; then
    mv "$tmp" "$file"
    echo "$tile.rd5: done ($(du -h "$file" | cut -f1))"
  else
    rm -f "$tmp"
    echo "$tile.rd5: up to date"
  fi
done
