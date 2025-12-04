#!/usr/bin/env bash

# AeroSpace workspace highlight script with animation
# Usage: aerospace.sh <workspace_id>

SELECTED="false"

if [ "$1" = "$FOCUSED_WORKSPACE" ]; then
    SELECTED="true"
fi

sketchybar --animate tanh 10 --set $NAME \
    icon.highlight=$SELECTED \
    background.highlight=$SELECTED
