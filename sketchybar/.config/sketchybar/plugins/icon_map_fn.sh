#!/bin/bash

# Icon map for sketchybar-app-font
# Reference: https://github.com/kvndrsslr/sketchybar-app-font

APP_NAME="$1"

case "$APP_NAME" in
"Activity Monitor") echo ":activity_monitor:" ;;
"Alfred") echo ":alfred:" ;;
"App Store") echo ":app_store:" ;;
"Arc") echo ":arc:" ;;
"Calculator") echo ":calculator:" ;;
"Calendar") echo ":calendar:" ;;
"Chrome" | "Google Chrome") echo ":google_chrome:" ;;
"Code" | "Visual Studio Code") echo ":visual_studio_code:" ;;
"Discord") echo ":discord:" ;;
"Docker" | "Docker Desktop") echo ":docker:" ;;
"Finder") echo ":finder:" ;;
"Firefox") echo ":firefox:" ;;
"Ghostty") echo ":terminal:" ;;
"GitHub Desktop") echo ":github:" ;;
"Hyper") echo ":hyper:" ;;
"iTerm" | "iTerm2") echo ":iterm:" ;;
"Kitty") echo ":kitty:" ;;
"Mail") echo ":mail:" ;;
"Maps") echo ":maps:" ;;
"Messages") echo ":messages:" ;;
"Microsoft Excel") echo ":microsoft_excel:" ;;
"Microsoft Outlook") echo ":microsoft_outlook:" ;;
"Microsoft PowerPoint") echo ":microsoft_power_point:" ;;
"Microsoft Teams") echo ":microsoft_teams:" ;;
"Microsoft Word") echo ":microsoft_word:" ;;
"Music") echo ":music:" ;;
"Notes") echo ":notes:" ;;
"Notion") echo ":notion:" ;;
"Numbers") echo ":numbers:" ;;
"Obsidian") echo ":obsidian:" ;;
"Pages") echo ":pages:" ;;
"Podcasts") echo ":podcasts:" ;;
"Postman") echo ":postman:" ;;
"Preview") echo ":preview:" ;;
"Reminders") echo ":reminders:" ;;
"Safari") echo ":safari:" ;;
"Sequel Pro" | "Sequel Ace") echo ":sequel_pro:" ;;
"Shortcuts") echo ":shortcuts:" ;;
"Slack") echo ":slack:" ;;
"System Preferences" | "System Settings") echo ":system_preferences:" ;;
"TablePlus") echo ":tableplus:" ;;
"Terminal") echo ":terminal:" ;;
"Telegram") echo ":telegram:" ;;
"Warp") echo ":warp:" ;;
"WhatsApp") echo ":whats_app:" ;;
"Xcode") echo ":xcode:" ;;
"Zed") echo ":zed:" ;;
"zoom.us") echo ":zoom:" ;;
*) echo ":default:" ;;
esac
