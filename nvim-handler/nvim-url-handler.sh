#!/bin/bash
set -euo pipefail
umask 077

readonly REX_BIN="$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"

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

[[ -x "$REX_BIN" ]] || die "Rex executable not found"
/usr/bin/open -b com.superlogical.rex
# JSON, not Lua or shell source: a URL must never become executable code.
json_path="${file_path//\\/\\\\}"
json_path="${json_path//\"/\\\"}"
printf '{"path":"%s","line":%s,"column":%s}' "$json_path" "${line:-1}" "${column:-1}" \
  | env -u REX_SESSION -u REX_BLOCK -u REX_CLIENT "$REX_BIN" do open_nvim --args - >/dev/null
/usr/bin/open -b com.superlogical.rex
