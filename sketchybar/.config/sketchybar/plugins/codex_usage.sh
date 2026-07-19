#!/bin/bash

# Codex subscription quota via the official Codex app-server RPC.
# The label shows the most constrained remaining quota, e.g. "41%".

DIR="$HOME/.config/sketchybar"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/sketchybar"
CACHE_FILE="$CACHE_DIR/codex_usage.json"
CACHE_MAX_AGE=1800
ITEM_NAME="${NAME:-codex_usage}"

source "$DIR/colors.sh"

find_codex_bin() {
  if [ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ]; then
    printf '%s\n' "$CODEX_BIN"
    return
  fi

  local path
  path=$(command -v codex 2>/dev/null)
  if [ -n "$path" ] && [ -x "$path" ]; then
    printf '%s\n' "$path"
    return
  fi

  for path in \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex" \
    "/Applications/ChatGPT.app/Contents/Resources/codex" \
    "/Applications/Codex.app/Contents/Resources/codex" \
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
    "$HOME/Applications/Codex.app/Contents/Resources/codex"; do
    if [ -x "$path" ]; then
      printf '%s\n' "$path"
      return
    fi
  done
}

fetch_usage() {
  local codex_bin="$1"

  {
    printf '%s\n' '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"sketchybar","title":"SketchyBar","version":"1.0.0"},"capabilities":{}}}'
    printf '%s\n' '{"method":"initialized","params":{}}'
    printf '%s\n' '{"method":"account/rateLimits/read","id":2,"params":{}}'
    sleep 4
  } | /usr/bin/perl -e '$timeout = shift; alarm $timeout; exec @ARGV' \
        8 "$codex_bin" -s read-only -a untrusted app-server 2>/dev/null \
      | jq -c 'select(.id == 2 and .result.rateLimits) | .result' 2>/dev/null \
      | tail -n 1
}

render_usage() {
  local usage="$1"
  local stale="$2"
  local summary label remaining color

  summary=$(printf '%s' "$usage" | jq -r '
    def windows:
      [.primary?, .secondary?]
      | map(select(type == "object" and .usedPercent != null))
      | unique_by(.windowDurationMins // 0)
      | sort_by(.windowDurationMins // 0);
    def remaining:
      (100 - ((.usedPercent // 0) | tonumber))
      | if . < 0 then 0 elif . > 100 then 100 else . end
      | round;

    (.rateLimitsByLimitId.codex // .rateLimits) as $limits
    | ($limits | windows | map(. | remaining)) as $remaining
    | select($remaining | length > 0)
    | [
        "\($remaining | min)%",
        ($remaining | min)
      ]
    | @tsv
  ' 2>/dev/null)

  [ -n "$summary" ] || return 1

  IFS=$'\t' read -r label remaining <<< "$summary"
  if [ "$remaining" -le 20 ]; then
    color=$RED
  elif [ "$remaining" -le 50 ]; then
    color=$YELLOW
  else
    color=$GREEN
  fi

  if [ "$stale" = true ]; then
    label="~$label"
    color=$DARK_WHITE
  fi

  sketchybar --set "$ITEM_NAME" \
             icon.color="$color" \
             label.color="$color" \
             label="$label"
}

render_error() {
  sketchybar --set "$ITEM_NAME" \
             icon.color="$RED" \
             label.color="$RED" \
             label="--"
}

load_recent_cache() {
  [ -s "$CACHE_FILE" ] || return 1

  local modified now age
  modified=$(stat -f '%m' "$CACHE_FILE" 2>/dev/null) || return 1
  now=$(date +%s)
  age=$((now - modified))
  [ "$age" -le "$CACHE_MAX_AGE" ] || return 1

  printf '%s' "$(<"$CACHE_FILE")"
}

main() {
  local codex_bin usage cached tmp_file

  if ! command -v jq >/dev/null 2>&1; then
    render_error
    return
  fi

  codex_bin=$(find_codex_bin)
  if [ -n "$codex_bin" ]; then
    usage=$(fetch_usage "$codex_bin")
  fi

  if [ -n "$usage" ] && render_usage "$usage" false; then
    umask 077
    mkdir -p "$CACHE_DIR"
    tmp_file="$CACHE_FILE.$$"
    if printf '%s\n' "$usage" > "$tmp_file"; then
      mv "$tmp_file" "$CACHE_FILE"
    else
      rm -f "$tmp_file"
    fi
    return
  fi

  cached=$(load_recent_cache)
  if [ -n "$cached" ] && render_usage "$cached" true; then
    return
  fi

  render_error
}

main
