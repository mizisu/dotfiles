#!/usr/bin/env bash
set -euo pipefail

pi_pane="${1:?pi pane id required}"
tmpfile="$(mktemp -t pi-feedback)"
buf_name="pi_feedback_$$"

cleanup() {
  rm -f "$tmpfile"
  tmux delete-buffer -b "$buf_name" 2>/dev/null || true
}
trap cleanup EXIT

# 사용자 nvim 설정/플러그인은 로드하되,
# VimEnter 시점에 강제로 scratch buffer를 열어 dashboard를 덮어씀
nvim -n \
  +"autocmd VimEnter * ++once silent! enew | file [pi-feedback] | setlocal buftype=nofile bufhidden=wipe noswapfile | startinsert" \
  +"autocmd VimLeavePre * if getline(1,'\$') != [''] | call writefile(getline(1,'\$'), '$tmpfile') | endif"

# nvim 종료 후 pi pane으로 복귀
# (스크롤모드면 해제하고, 작성한 내용을 그대로 붙여넣기)
tmux select-pane -t "$pi_pane" 2>/dev/null || exit 0
if [ "$(tmux display-message -p -t "$pi_pane" '#{pane_in_mode}' 2>/dev/null || echo 0)" = "1" ]; then
  tmux send-keys -t "$pi_pane" -X cancel
fi

if [ -s "$tmpfile" ]; then
  tmux load-buffer -b "$buf_name" "$tmpfile"
  tmux paste-buffer -p -d -b "$buf_name" -t "$pi_pane"
fi
