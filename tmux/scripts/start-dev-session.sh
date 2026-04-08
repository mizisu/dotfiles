#!/usr/bin/env bash
set -euo pipefail

cwd="${1:?current path required}"
window_name="dev"
launch_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"

session_base="$(basename "$launch_root")"
if [ "$session_base" = "/" ] || [ -z "$session_base" ]; then
  session_base="root"
fi
session_base="$(printf '%s' "$session_base" | tr -cs '[:alnum:]' '-')"
session_base="${session_base#-}"
session_base="${session_base%-}"
if [ -z "$session_base" ]; then
  session_base="dev"
fi

session_name="$session_base"
suffix=2
while tmux has-session -t "$session_name" 2>/dev/null; do
  session_name="${session_base}-${suffix}"
  suffix=$((suffix + 1))
done

app_dir="$launch_root/app"
printf -v left_cmd 'cd %q && uv run manage.py runserver 0.0.0.0:7777 --settings=server.settings.local --skip-checks' "$launch_root"
printf -v right_cmd 'cd %q && pnpm start' "$app_dir"

tmux new-session -d -s "$session_name" -n "$window_name" "$left_cmd"
tmux split-window -h -t "${session_name}:${window_name}" "$right_cmd"
tmux set-option -t "$session_name" remain-on-exit on

tmux select-layout -t "${session_name}:${window_name}" even-horizontal >/dev/null
tmux select-pane -t "${session_name}:${window_name}.1"
tmux switch-client -t "$session_name"
