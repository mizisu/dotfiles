#!/bin/bash

# Click WiFi menu bar item in Control Center
osascript -e 'tell application "System Events" to tell process "ControlCenter" to click (first menu bar item of menu bar 1 whose description contains "Wi")'
