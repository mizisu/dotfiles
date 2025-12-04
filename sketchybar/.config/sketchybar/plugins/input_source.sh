#!/bin/bash

# Input source plugin - shows current keyboard layout (EN/한)

# Check both keyboard layout and input method
INPUT_SOURCE=$(defaults read ~/Library/Preferences/com.apple.HIToolbox.plist AppleSelectedInputSources 2>/dev/null)

if echo "$INPUT_SOURCE" | grep -q "Korean"; then
  LABEL="한"
elif echo "$INPUT_SOURCE" | grep -q "ABC\|US\|com.apple.keylayout"; then
  LABEL="EN"
else
  LABEL="??"
fi

sketchybar --set $NAME label="$LABEL"
