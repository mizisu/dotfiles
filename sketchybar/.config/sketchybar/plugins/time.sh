#!/bin/bash

# Time script (date + time: YYYY-MM-DD HH:MM format)
LABEL=$(date '+%Y-%m-%d %H:%M')
sketchybar --set $NAME label="$LABEL"
