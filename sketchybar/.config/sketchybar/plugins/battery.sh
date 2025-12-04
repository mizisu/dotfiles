#!/bin/bash

# Battery script with Nerd Font icons

PERCENTAGE=$(pmset -g batt | grep -Eo "\d+%" | cut -d% -f1)
CHARGING=$(pmset -g batt | grep 'AC Power')

if [ "$PERCENTAGE" = "" ]; then
  exit 0
fi

# Nerd Font battery icons
case ${PERCENTAGE} in
  9[0-9]|100) ICON="󰁹" ;;  # full
  [7-8][0-9]) ICON="󰂁" ;;  # 80%
  [5-6][0-9]) ICON="󰁿" ;;  # 60%
  [3-4][0-9]) ICON="󰁽" ;;  # 40%
  [1-2][0-9]) ICON="󰁻" ;;  # 20%
  *) ICON="󰁺"              # low
esac

if [[ $CHARGING != "" ]]; then
  ICON="󰂄"  # charging
fi

sketchybar --set $NAME icon="$ICON" label="${PERCENTAGE}%"
