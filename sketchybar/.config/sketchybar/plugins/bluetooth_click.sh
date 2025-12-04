#!/bin/bash

# Bluetooth click handler - open Bluetooth menu in Control Center
osascript -e 'tell application "System Events" to tell process "ControlCenter" to click (first menu bar item of menu bar 1 whose description contains "Bluetooth")'
