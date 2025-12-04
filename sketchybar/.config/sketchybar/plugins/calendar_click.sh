#!/bin/bash

# Calendar click handler
# Opens Zoom link if available, otherwise opens Google Calendar

CACHE_FILE="$HOME/.cache/sketchybar/calendar_zoom_link"

ZOOM_LINK=""
if [ -f "$CACHE_FILE" ]; then
  ZOOM_LINK=$(cat "$CACHE_FILE")
fi

if [ -n "$ZOOM_LINK" ]; then
  # Open Zoom link
  open "$ZOOM_LINK"
else
  # Open Google Calendar
  open "https://calendar.google.com"
fi
