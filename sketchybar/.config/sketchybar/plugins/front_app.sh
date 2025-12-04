#!/bin/sh

# Front app script with app icon support
# Requires: sketchybar-app-font (brew install --cask font-sketchybar-app-font)

if [ "$SENDER" = "front_app_switched" ]; then
  sketchybar --set $NAME label="$INFO" icon="$($CONFIG_DIR/plugins/icon_map_fn.sh "$INFO")"
fi
