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

left_pane="$(tmux new-session -d -P -F '#{pane_id}' -s "$session_name" -n "$window_name" -c "$launch_root")"
right_pane="$(tmux split-window -h -P -F '#{pane_id}' -t "${session_name}:${window_name}" -c "$launch_root")"

tmux send-keys -t "$left_pane" "$left_cmd" C-m
tmux send-keys -t "$right_pane" "$right_cmd" C-m

tmux select-layout -t "${session_name}:${window_name}" even-horizontal >/dev/null
tmux select-pane -t "$left_pane"
tmux switch-client -t "$session_name"
