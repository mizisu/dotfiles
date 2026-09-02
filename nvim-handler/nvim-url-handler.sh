#!/bin/bash
set -euo pipefail
umask 077

readonly NVIM_BIN="/opt/homebrew/bin/nvim"
readonly CACHE_DIR="$HOME/.cache/nvim"
readonly SERVER_PIPE="$CACHE_DIR/server.pipe"

die() {
  printf 'NvimHandler: %s\n' "$*" >&2
  exit 1
}

url_decode_path() {
  local encoded="$1" decoded="" hex byte
  while [[ "$encoded" == *%* ]]; do
    decoded+="${encoded%%\%*}"
    encoded="${encoded#*%}"
    (( ${#encoded} >= 2 )) || return 1
    hex="${encoded:0:2}"
    [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]] || return 1
    [[ ! "$hex" =~ ^([01][0-9A-Fa-f]|7[Ff])$ ]] || return 1
    printf -v byte '%b' "\\x$hex"
    decoded+="$byte"
    encoded="${encoded:2}"
  done
  printf '%s' "$decoded$encoded"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$(url_decode_path "/tmp/a%20b%27c")" == "/tmp/a b'c" ]]
  ! url_decode_path "/tmp/%0A" >/dev/null
  printf 'NvimHandler self-test passed\n'
  exit 0
fi

url="${1:-}"
[[ "$url" == nvim://file/* ]] || die "unsupported or missing URL"
(( ${#url} <= 8192 )) || die "URL is too long"

file_info="$(url_decode_path "${url#nvim://file/}")" || die "invalid percent encoding"
file_path="$file_info"
line=""
column=""
if [[ "$file_info" =~ ^(.+):([0-9]+):([0-9]+)$ ]]; then
  file_path="${BASH_REMATCH[1]}"
  line="${BASH_REMATCH[2]}"
  column="${BASH_REMATCH[3]}"
elif [[ "$file_info" =~ ^(.+):([0-9]+)$ ]]; then
  file_path="${BASH_REMATCH[1]}"
  line="${BASH_REMATCH[2]}"
fi

[[ "$file_path" == /* ]] || die "file path must be absolute"
if LC_ALL=C printf '%s' "$file_path" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  die "file path contains control characters"
fi
if [[ -n "$line" ]]; then
  (( ${#line} <= 10 )) || die "line number is too large"
  line=$((10#$line))
  (( line >= 1 && line <= 2147483647 )) || die "invalid line number"
fi
if [[ -n "$column" ]]; then
  (( ${#column} <= 10 )) || die "column number is too large"
  column=$((10#$column))
  (( column >= 1 && column <= 2147483647 )) || die "invalid column number"
fi

[[ -x "$NVIM_BIN" && -f "$NVIM_BIN" ]] || die "Neovim executable not found"
[[ ! -L "$CACHE_DIR" ]] || die "refusing symlinked cache directory"
mkdir -p "$CACHE_DIR"
[[ -O "$CACHE_DIR" ]] || die "cache directory is not owned by the current user"
chmod 700 "$CACHE_DIR"

server_running=false
if [[ -S "$SERVER_PIPE" && ! -L "$SERVER_PIPE" && -O "$SERVER_PIPE" ]] \
  && "$NVIM_BIN" --server "$SERVER_PIPE" --remote-expr '1' >/dev/null 2>&1; then
  server_running=true
elif [[ -e "$SERVER_PIPE" || -L "$SERVER_PIPE" ]]; then
  [[ -S "$SERVER_PIPE" && ! -L "$SERVER_PIPE" && -O "$SERVER_PIPE" ]] \
    || die "refusing unsafe server path"
  rm -f "$SERVER_PIPE"
fi

if [[ "$server_running" != true ]]; then
  nvim_args=(--listen "$SERVER_PIPE")
  [[ -z "$line" ]] || nvim_args+=("+call cursor($line, ${column:-1})")
  nvim_args+=(-- "$file_path")
  /usr/bin/open -na Ghostty --args -e "$NVIM_BIN" "${nvim_args[@]}"
  # ponytail: no startup lock; add lockf only if simultaneous URL opens become real.
  exit 0
fi

single_quote="'"
vim_path="${file_path//$single_quote/$single_quote$single_quote}"
remote_expression="execute('edit ' . fnameescape('$vim_path'))"
[[ -z "$line" ]] || remote_expression="[$remote_expression, cursor($line, ${column:-1})][-1]"
"$NVIM_BIN" --server "$SERVER_PIPE" --remote-expr "$remote_expression" >/dev/null
/usr/bin/osascript -e 'tell application "Ghostty" to activate'
