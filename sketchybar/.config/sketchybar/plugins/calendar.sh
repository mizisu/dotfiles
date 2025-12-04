#!/bin/bash

# Calendar plugin - shows next event from "Charles" calendar
# Format: [icon] [time remaining]: [title]
# - Ended events: skip
# - In progress: show time remaining until end
# - Upcoming: show time until start

CACHE_DIR="$HOME/.cache/sketchybar"
CACHE_FILE="$CACHE_DIR/calendar_zoom_link"
mkdir -p "$CACHE_DIR"

NOW_EPOCH=$(date "+%s")

# Get events from Charles calendar (from now to end of tomorrow)
# Format: "title | start_time - end_time"
EVENTS=$(icalBuddy -nc -ic "Charles" -ea -df "%Y-%m-%d" -tf "%H:%M" -iep "title,datetime" -b "" -ps "| |" eventsFrom:today to:tomorrow+1 2>/dev/null)

if [ -z "$EVENTS" ]; then
  sketchybar --set $NAME icon="󰃰" label=""
  echo "" > "$CACHE_FILE"
  exit 0
fi

# Parse all events into arrays
CURRENT_EVENT=""
CURRENT_START=""
CURRENT_END=""
CURRENT_DATE=""
NEXT_EVENT=""
NEXT_START=""
NEXT_END=""
NEXT_DATE=""

while IFS= read -r EVENT; do
  [ -z "$EVENT" ] && continue
  
  # Parse title - extract everything before the date/time part
  TITLE=$(echo "$EVENT" | sed -E 's/ (today at|tomorrow at|day after tomorrow at|[0-9]{4}-[0-9]{2}-[0-9]{2}).*$//' | xargs)
  [ -z "$TITLE" ] && continue
  
  # Extract times - format: "YYYY-MM-DD HH:MM - HH:MM" or "today at HH:MM - HH:MM"
  TIME_PART=$(echo "$EVENT" | grep -oE '([0-9]{4}-[0-9]{2}-[0-9]{2}|today at|tomorrow at) [0-9]{2}:[0-9]{2} - [0-9]{2}:[0-9]{2}' | head -1)
  
  if [ -z "$TIME_PART" ]; then
    # Try simpler format
    TIMES=$(echo "$EVENT" | grep -oE '[0-9]{2}:[0-9]{2}' | head -2)
    START_HM=$(echo "$TIMES" | head -1)
    END_HM=$(echo "$TIMES" | tail -1)
    [ -z "$START_HM" ] && continue
    DATE_PREFIX=$(date +%Y-%m-%d)
  else
    if echo "$TIME_PART" | grep -q "today at"; then
      DATE_PREFIX=$(date +%Y-%m-%d)
    elif echo "$TIME_PART" | grep -q "tomorrow at"; then
      DATE_PREFIX=$(date -v+1d +%Y-%m-%d)
    else
      DATE_PREFIX=$(echo "$TIME_PART" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
    fi
    START_HM=$(echo "$TIME_PART" | grep -oE '[0-9]{2}:[0-9]{2}' | head -1)
    END_HM=$(echo "$TIME_PART" | grep -oE '[0-9]{2}:[0-9]{2}' | tail -1)
  fi
  
  [ -z "$START_HM" ] || [ -z "$END_HM" ] && continue
  
  START_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "$DATE_PREFIX $START_HM" "+%s" 2>/dev/null)
  END_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "$DATE_PREFIX $END_HM" "+%s" 2>/dev/null)
  
  [ -z "$START_EPOCH" ] || [ -z "$END_EPOCH" ] && continue
  
  # Handle case where end time is before start (next day)
  if [ "$END_EPOCH" -lt "$START_EPOCH" ]; then
    END_EPOCH=$((END_EPOCH + 86400))
  fi
  
  # Skip ended events
  if [ "$NOW_EPOCH" -ge "$END_EPOCH" ]; then
    continue
  fi
  
  # Check if event is in progress
  if [ "$NOW_EPOCH" -ge "$START_EPOCH" ] && [ "$NOW_EPOCH" -lt "$END_EPOCH" ]; then
    # Store current (in progress) event if not already set
    if [ -z "$CURRENT_EVENT" ]; then
      CURRENT_EVENT="$TITLE"
      CURRENT_START="$START_EPOCH"
      CURRENT_END="$END_EPOCH"
      CURRENT_DATE="$DATE_PREFIX"
    fi
  else
    # This is an upcoming event
    if [ -z "$NEXT_EVENT" ]; then
      NEXT_EVENT="$TITLE"
      NEXT_START="$START_EPOCH"
      NEXT_END="$END_EPOCH"
      NEXT_DATE="$DATE_PREFIX"
      # If we already have a current event, we can stop
      if [ -n "$CURRENT_EVENT" ]; then
        break
      fi
    fi
  fi
  
  # If we have both current and next, stop searching
  if [ -n "$CURRENT_EVENT" ] && [ -n "$NEXT_EVENT" ]; then
    break
  fi
  
done <<< "$EVENTS"

# Determine which event to display
# If there's an upcoming event within 5 minutes, show that instead of current
FOUND_TITLE=""
FOUND_START=""
FOUND_END=""
FOUND_DATE=""
IS_IN_PROGRESS=false

if [ -n "$NEXT_EVENT" ] && [ -n "$CURRENT_EVENT" ]; then
  # Both exist - check if next event starts within 5 minutes
  MINS_UNTIL_NEXT=$(( (NEXT_START - NOW_EPOCH) / 60 ))
  if [ "$MINS_UNTIL_NEXT" -le 5 ]; then
    # Show next event
    FOUND_TITLE="$NEXT_EVENT"
    FOUND_START="$NEXT_START"
    FOUND_END="$NEXT_END"
    FOUND_DATE="$NEXT_DATE"
    IS_IN_PROGRESS=false
  else
    # Show current event
    FOUND_TITLE="$CURRENT_EVENT"
    FOUND_START="$CURRENT_START"
    FOUND_END="$CURRENT_END"
    FOUND_DATE="$CURRENT_DATE"
    IS_IN_PROGRESS=true
  fi
elif [ -n "$CURRENT_EVENT" ]; then
  FOUND_TITLE="$CURRENT_EVENT"
  FOUND_START="$CURRENT_START"
  FOUND_END="$CURRENT_END"
  FOUND_DATE="$CURRENT_DATE"
  IS_IN_PROGRESS=true
elif [ -n "$NEXT_EVENT" ]; then
  FOUND_TITLE="$NEXT_EVENT"
  FOUND_START="$NEXT_START"
  FOUND_END="$NEXT_END"
  FOUND_DATE="$NEXT_DATE"
  IS_IN_PROGRESS=false
fi

if [ -z "$FOUND_TITLE" ]; then
  sketchybar --set $NAME icon="󰃰" label=""
  echo "" > "$CACHE_FILE"
  exit 0
fi

# Get zoom link for this specific event (match by title + start time)
FOUND_START_TIME=$(date -r "$FOUND_START" "+%H:%M")
FULL_EVENTS=$(icalBuddy -nc -ic "Charles" -ea -tf "%H:%M" -iep "title,datetime,notes" -b "###EVENT###" -ps "|\n|" eventsFrom:today to:tomorrow+1 2>/dev/null)

# Extract zoom link from the event block matching both title and start time
ZOOM_LINK=$(echo "$FULL_EVENTS" | awk -v title="$FOUND_TITLE" -v start_time="$FOUND_START_TIME" '
  BEGIN { block=""; found=0 }
  /^###EVENT###/ { 
    if (found && index(block, start_time) > 0) {
      print block
      exit
    }
    block=$0 "\n"
    found = (index($0, title) > 0)
    next
  }
  { block = block $0 "\n" }
  END {
    if (found && index(block, start_time) > 0) {
      print block
    }
  }
' | grep -oE 'https://[a-zA-Z0-9.-]*zoom\.(us|com)/j/[0-9]+[^ ]*' | head -1)

echo "$ZOOM_LINK" > "$CACHE_FILE"

# Truncate title (max 10 chars)
DISPLAY_TITLE="${FOUND_TITLE:0:10}"
if [ ${#FOUND_TITLE} -gt 10 ]; then
  DISPLAY_TITLE="${DISPLAY_TITLE}…"
fi

# Calculate time and format display
# Icons: 󰃰 for in progress, 󰃭 for upcoming
if [ "$IS_IN_PROGRESS" = true ]; then
  # Event in progress - show time remaining until end
  ICON="󰃰"
  DIFF_MIN=$(( (FOUND_END - NOW_EPOCH) / 60 ))
  if [ $DIFF_MIN -lt 60 ]; then
    TIME_STR="${DIFF_MIN}m 남음"
  else
    HOURS=$(( DIFF_MIN / 60 ))
    MINS=$(( DIFF_MIN % 60 ))
    if [ $MINS -eq 0 ]; then
      TIME_STR="${HOURS}h 남음"
    else
      TIME_STR="${HOURS}h ${MINS}m 남음"
    fi
  fi
else
  # Event upcoming - show time until start
  ICON="󰃭"
  DIFF_MIN=$(( (FOUND_START - NOW_EPOCH) / 60 ))
  TODAY=$(date +%Y-%m-%d)
  if [ "$FOUND_DATE" != "$TODAY" ]; then
    TIME_STR="내일"
  elif [ $DIFF_MIN -lt 60 ]; then
    TIME_STR="${DIFF_MIN}m 후"
  else
    HOURS=$(( DIFF_MIN / 60 ))
    MINS=$(( DIFF_MIN % 60 ))
    if [ $MINS -eq 0 ]; then
      TIME_STR="${HOURS}h 후"
    else
      TIME_STR="${HOURS}h ${MINS}m 후"
    fi
  fi
fi

sketchybar --set $NAME icon="$ICON" label="$TIME_STR: $DISPLAY_TITLE"
