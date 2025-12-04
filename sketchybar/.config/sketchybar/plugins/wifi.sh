#!/bin/bash

# WiFi script - icon only

# Check if we have an IP on en0 (WiFi interface)
IP=$(ipconfig getifaddr en0 2>/dev/null)

if [ -n "$IP" ]; then
  ICON="󰤨"  # wifi on
else
  ICON="󰤭"  # wifi off
fi

sketchybar --set $NAME icon="$ICON" label=""
