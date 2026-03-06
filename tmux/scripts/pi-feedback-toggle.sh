#!/usr/bin/env bash
set -euo pipefail

pi_pane="${1:?}"
window_id="${2:?}"
cwd="${3:?}"
marker="__pi_feedback__"

# 현재 윈도우에서 피드백 pane 찾기(여러 pane 있어도 이것만 타겟)
feedback_pane="$(tmux list-panes -t "$window_id" -F '#{pane_id} #{pane_title}' \
  | awk -v m="$marker" '$2==m {print $1; exit}')"

if [ -n "$feedback_pane" ]; then
  # 토글로 닫을 때도 nvim 정상 종료시켜서 내용이 pi pane으로 붙도록 함
  tmux send-keys -t "$feedback_pane" Escape
  tmux send-keys -t "$feedback_pane" :qa! Enter
  exit 0
fi

new_pane="$(tmux split-window -v -p 15 -d -t "$pi_pane" -c "$cwd" -P -F '#{pane_id}' \
  "$HOME/.tmux/scripts/pi-feedback-editor.sh $pi_pane")"

tmux set-option -pt "$new_pane" remain-on-exit off
tmux select-pane -t "$new_pane" -T "$marker"

# 요구사항: 기본 상태는 위(pi) pane + 스크롤 가능 상태
tmux select-pane -t "$pi_pane"
tmux copy-mode -t "$pi_pane"
