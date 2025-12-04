#!/bin/bash

# Volume script with Nerd Font icons

if [ "$SENDER" = "volume_change" ]; then
  VOLUME="$INFO"
else
  VOLUME=$(osascript -e 'output volume of (get volume settings)')
fi

MUTED=$(osascript -e 'output muted of (get volume settings)')

if [ "$MUTED" = "true" ]; then
  ICON="󰝟"
elif [ "$VOLUME" -eq 0 ] 2>/dev/null; then
  ICON="󰕿"
elif [ "$VOLUME" -lt 33 ] 2>/dev/null; then
  ICON="󰖀"
else
  ICON="󰕾"
fi

sketchybar --set $NAME icon="$ICON" label="${VOLUME}%"
