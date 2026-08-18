#!/bin/bash

set -euo pipefail

SKETCHYBAR="/opt/homebrew/bin/sketchybar"
AEROSPACE="/opt/homebrew/bin/aerospace"

BAR_HIDDEN="$($SKETCHYBAR --query bar | /usr/bin/plutil -extract hidden raw -o - -)"

# Restoring the normal AeroSpace config reserves room for SketchyBar again.
if [[ "$BAR_HIDDEN" == "on" ]]; then
  "$AEROSPACE" reload-config --no-gui
  "$SKETCHYBAR" --bar hidden=off
  exit 0
fi

CONFIG_PATH="$(/bin/realpath "$($AEROSPACE config --config-path)")"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
BACKUP="$(/usr/bin/mktemp "$TMP_BASE/aerospace-config.XXXXXX")"
COMPACT_CONFIG="$(/usr/bin/mktemp "$TMP_BASE/aerospace-compact.XXXXXX")"
HIDE_SUCCEEDED=0

cleanup() {
  /bin/cp -p "$BACKUP" "$CONFIG_PATH" 2>/dev/null || true
  /bin/rm -f "$BACKUP" "$COMPACT_CONFIG"

  if [[ "$HIDE_SUCCEEDED" -eq 0 ]]; then
    "$SKETCHYBAR" --bar hidden=off 2>/dev/null || true
  fi
}
trap cleanup EXIT

/bin/cp -p "$CONFIG_PATH" "$BACKUP"

# AeroSpace cannot change gaps at runtime. Load a temporary copy with only the
# regular 10 px outer margin, then immediately restore the tracked config file.
/usr/bin/awk '
  /^[[:space:]]*outer[.]top[[:space:]]*=/ {
    print "      outer.top =        10"
    matches++
    next
  }
  { print }
  END { if (matches != 1) exit 1 }
' "$CONFIG_PATH" > "$COMPACT_CONFIG"

"$SKETCHYBAR" --bar hidden=on
/bin/cp "$COMPACT_CONFIG" "$CONFIG_PATH"
"$AEROSPACE" reload-config --no-gui
HIDE_SUCCEEDED=1
