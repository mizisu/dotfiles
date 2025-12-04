#!/bin/bash

# Bluetooth plugin - icon only

# Check bluetooth power state
BT_STATE=$(blueutil -p 2>/dev/null)

if [ "$BT_STATE" = "1" ]; then
  ICON="󰂯"  # bluetooth on
else
  ICON="󰂲"  # bluetooth off
fi

sketchybar --set $NAME icon="$ICON" label=""
