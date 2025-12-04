#!/bin/bash

# Time script (chenxin-yan style: date + time combined)
LABEL=$(date '+%d %b %a %H:%M')
sketchybar --set $NAME label="$LABEL"
