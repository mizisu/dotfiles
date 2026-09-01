#!/bin/bash

# Calendar click handler
# Opens Zoom link if available, otherwise opens Google Calendar

CACHE_DIR="$HOME/.cache/sketchybar"
CACHE_FILE="$CACHE_DIR/calendar_zoom_link"

ZOOM_LINK=""
if [ -d "$CACHE_DIR" ] && [ ! -L "$CACHE_DIR" ] && [ -O "$CACHE_DIR" ] \
  && [ -f "$CACHE_FILE" ] && [ ! -L "$CACHE_FILE" ] && [ -O "$CACHE_FILE" ]; then
  IFS= read -r ZOOM_LINK < "$CACHE_FILE"
fi

if [[ "$ZOOM_LINK" =~ ^https://([a-zA-Z0-9-]+\.)*zoom\.(us|com)/j/[0-9]+([/?#][^[:space:]]*)?$ ]]; then
  # Open only a validated HTTPS Zoom meeting URL.
  /usr/bin/open "$ZOOM_LINK"
else
  /usr/bin/open "https://calendar.google.com"
fi
