#!/usr/bin/env python3
"""Flash-like jump for tmux, implemented as a full-screen popup.

The popup owns keyboard input, so search keys never leak into the focused pane.
It renders a captured copy of the current pane, updates labels as the query is
typed, then closes and moves the tmux copy-mode cursor to the selected match.
"""

from __future__ import annotations

import argparse
import itertools
import os
import select
import shlex
import shutil
import string
import subprocess
import sys
import termios
import tty
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

ESC = "\033"
CLEAR = f"{ESC}[2J"
HOME = f"{ESC}[H"
RESET = f"{ESC}[0m"
HIDE_CURSOR = f"{ESC}[?25l"
SHOW_CURSOR = f"{ESC}[?25h"
CLEAR_LINE = f"{ESC}[2K"

DEFAULT_KEYS = "jfkdlsahgurieowpq"
FALLBACK_LABEL_KEYS = "1234567890"
DEFAULT_DIM_COLOR = r"\e[0m\e[90m"
DEFAULT_LABEL_COLOR = r"\e[1m\e[35m"


@dataclass
class PaneInfo:
    pane_id: str
    scroll_position: int
    height: int
    width: int


@dataclass
class JumpState:
    query: str
    label_prefix: str
    positions: list[int]
    labels: list[str]
    unsafe_first: set[str]


def tmux(*args: object, check: bool = True) -> str:
    proc = subprocess.run(
        ["tmux", *map(str, args)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"tmux {' '.join(map(str, args))} failed")
    return proc.stdout


def chomp(value: str) -> str:
    return value[:-1] if value.endswith("\n") else value


def get_option(name: str, default: str) -> str:
    value = chomp(tmux("show-option", "-gqv", name, check=False))
    return value if value else default


def decode_ansi(value: str) -> str:
    return value.replace(r"\e", ESC).replace(r"\033", ESC)


def script_path() -> str:
    return os.path.abspath(__file__)


def launch_popup(pane_id: str, client_name: str) -> int:
    pane_id = pane_id or chomp(tmux("display-message", "-p", "-F", "#{pane_id}"))
    client_name = client_name or chomp(tmux("display-message", "-p", "-F", "#{client_name}", check=False))
    command = (
        f"python3 {shlex.quote(script_path())} "
        f"--pane {shlex.quote(pane_id)} --client {shlex.quote(client_name)}"
    )
    tmux(
        "display-popup",
        "-B",
        "-E",
        "-w",
        "100%",
        "-h",
        "100%",
        "-x",
        "0",
        "-y",
        "0",
        command,
    )
    return 0


def get_pane_info(pane_id: str) -> PaneInfo:
    fmt = "#{pane_id}\t#{scroll_position}\t#{pane_height}\t#{pane_width}"
    parts = chomp(tmux("display-message", "-p", "-t", pane_id, "-F", fmt)).split("\t")
    if len(parts) != 4:
        raise RuntimeError("could not read pane information")
    return PaneInfo(
        pane_id=parts[0],
        scroll_position=int(parts[1] or 0),
        height=int(parts[2] or 0),
        width=int(parts[3] or 0),
    )


def capture_visible_text(info: PaneInfo) -> str:
    start = -info.scroll_position
    end = start + info.height - 1
    text = tmux("capture-pane", "-p", "-t", info.pane_id, "-S", start, "-E", end)
    return chomp(text).replace("\ufe0e", "")


def find_matches(text: str, query: str) -> list[int]:
    if not query:
        return []

    case_sensitive = any(char.isupper() for char in query)
    haystack = text if case_sensitive else text.lower()
    needle = query if case_sensitive else query.lower()

    matches: list[int] = []
    index = 0
    while True:
        found = haystack.find(needle, index)
        if found == -1:
            return matches
        matches.append(found)
        index = found + 1


def next_query_chars(text: str, query: str, positions: list[int]) -> set[str]:
    chars: set[str] = set()
    query_len = len(query)
    for position in positions:
        index = position + query_len
        if index < len(text) and text[index] not in " \t\r\n":
            chars.add(text[index].lower())
    return chars


def label_key_list(keys: str) -> list[str]:
    keys = "".join(char.lower() for char in keys if len(char) == 1)
    return list(dict.fromkeys(keys + FALLBACK_LABEL_KEYS))


def labels_for(count: int, keys: str, excluded_first: set[str]) -> list[str]:
    if count <= 0:
        return []

    all_keys = label_key_list(keys)
    first_keys = [key for key in all_keys if key not in excluded_first]
    if not first_keys:
        return []

    label_len = 1
    capacity = len(first_keys)
    while capacity < count:
        label_len += 1
        capacity *= len(all_keys)

    if label_len == 1:
        return first_keys[:count]

    labels = (
        first + "".join(rest)
        for first in first_keys
        for rest in itertools.product(all_keys, repeat=label_len - 1)
    )
    return list(itertools.islice(labels, count))


def remove_overlaps(positions: list[int], label_len: int) -> list[int]:
    visible: list[int] = []
    cursor = 0
    for position in positions:
        if position >= cursor:
            visible.append(position)
            cursor = position + label_len
    return visible


def visible_positions_and_labels(
    positions: list[int],
    keys: str,
    excluded_first: set[str],
) -> tuple[list[int], list[str]]:
    current = positions
    while current:
        labels = labels_for(len(current), keys, excluded_first)
        if not labels:
            return [], []
        filtered = remove_overlaps(current, len(labels[0]))
        if len(filtered) == len(current):
            return current, labels
        current = filtered
    return [], []


def update_matches(text: str, keys: str, state: JumpState) -> None:
    all_positions = find_matches(text, state.query)
    state.unsafe_first = next_query_chars(text, state.query, all_positions)
    state.positions, state.labels = visible_positions_and_labels(all_positions, keys, state.unsafe_first)


def build_overlay(text: str, state: JumpState, dim: str, label_color: str) -> str:
    if not state.labels:
        return f"{dim}{text}{RESET}"

    pieces: list[str] = []
    cursor = 0
    label_len = len(state.labels[0])
    for position, label in zip(state.positions, state.labels):
        pieces.append(dim)
        pieces.append(text[cursor:position])
        pieces.append(label_color)
        pieces.append(label)
        cursor = position + label_len
    pieces.append(dim)
    pieces.append(text[cursor:])
    pieces.append(RESET)
    return "".join(pieces)


def status_text(state: JumpState) -> str:
    if not state.query:
        return "flash: type search, Esc to cancel"
    if not state.labels:
        return f"flash[0]: {state.query}"
    if state.label_prefix:
        return f"flash[{len(state.labels)}]: {state.query}  label: {state.label_prefix}"
    return f"flash[{len(state.labels)}]: {state.query}"


def draw(text: str, state: JumpState, dim: str, label_color: str) -> None:
    size = shutil.get_terminal_size((120, 40))
    body_rows = max(size.lines - 1, 1)
    overlay = build_overlay(text, state, dim, label_color).replace("\n", "\r\n")
    lines = overlay.split("\r\n")[:body_rows]
    status = status_text(state)[: max(size.columns - 1, 1)]
    sys.stdout.write(
        HIDE_CURSOR
        + CLEAR
        + HOME
        + "\r\n".join(lines)
        + RESET
        + f"{ESC}[{size.lines};1H"
        + CLEAR_LINE
        + status
    )
    sys.stdout.flush()


@contextmanager
def raw_terminal() -> Iterator[None]:
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write(RESET + SHOW_CURSOR)
        sys.stdout.flush()


def read_key() -> str | None:
    fd = sys.stdin.fileno()
    first = os.read(fd, 1)
    if not first:
        return None

    byte = first[0]
    if byte == 0x1B:
        # Treat plain Escape as cancel; ignore escape sequences such as arrows.
        ready, _, _ = select.select([fd], [], [], 0.01)
        if ready:
            os.read(fd, 16)
            return None
        return "Escape"
    if byte in (0x03, 0x07):
        return "Escape"
    if byte in (0x7F, 0x08):
        return "Backspace"
    if byte in (0x0D, 0x0A):
        return "Enter"
    if byte == 0x09:
        return "\t"
    if byte < 0x20:
        return None
    if byte < 0x80:
        return chr(byte)

    data = bytearray(first)
    for _ in range(3):
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            data.extend(os.read(fd, 1))
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def label_has_prefix(labels: list[str], prefix: str) -> bool:
    return any(label.startswith(prefix) for label in labels)


def handle_key(key: str, text: str, keys: str, state: JumpState) -> int | None:
    if key == "Escape":
        return -1

    if key == "Backspace":
        if state.label_prefix:
            state.label_prefix = state.label_prefix[:-1]
        else:
            state.query = state.query[:-1]
            update_matches(text, keys, state)
        return None

    if key == "Enter":
        return None

    if key not in string.printable and len(key) != 1:
        return None

    lower = key.lower()
    if state.label_prefix:
        prefix = state.label_prefix + lower
        if not label_has_prefix(state.labels, prefix):
            return None
        state.label_prefix = prefix
        return state.labels.index(prefix) if prefix in state.labels else None

    is_safe_label = (
        bool(state.query)
        and lower not in state.unsafe_first
        and label_has_prefix(state.labels, lower)
    )
    if is_safe_label:
        state.label_prefix = lower
        return state.labels.index(lower) if lower in state.labels else None

    state.query += key
    state.label_prefix = ""
    update_matches(text, keys, state)
    return None


def send_copy_command(info: PaneInfo, command: str, count: int | None = None) -> None:
    args: list[object] = ["send-keys", "-X", "-t", info.pane_id]
    if count is not None and count > 0:
        args.extend(["-N", count])
    args.append(command)
    tmux(*args, check=False)


def jump_to(info: PaneInfo, flat_index: int, client_name: str) -> None:
    tmux("copy-mode", "-t", info.pane_id, check=False)

    # Reset to the top-left of the captured viewport. The first cursor-right
    # pass avoids a tmux edge case when the first visible line is empty.
    send_copy_command(info, "start-of-line")
    send_copy_command(info, "top-line")
    send_copy_command(info, "cursor-right", max(200, info.width * 2))
    send_copy_command(info, "start-of-line")
    send_copy_command(info, "top-line")

    if info.scroll_position > 0:
        send_copy_command(info, "cursor-up", info.scroll_position)
    send_copy_command(info, "cursor-right", flat_index)

    if client_name:
        tmux("refresh-client", "-t", client_name, check=False)
    else:
        tmux("refresh-client", check=False)


def run_popup(pane_id: str, client_name: str) -> int:
    pane_id = pane_id or chomp(tmux("display-message", "-p", "-F", "#{pane_id}"))
    client_name = client_name or chomp(tmux("display-message", "-p", "-F", "#{client_name}", check=False))
    info = get_pane_info(pane_id)
    text = capture_visible_text(info)
    keys = get_option("@flash-jump-keys", DEFAULT_KEYS)
    dim = decode_ansi(get_option("@flash-jump-bg-color", DEFAULT_DIM_COLOR))
    label_color = decode_ansi(get_option("@flash-jump-fg-color", DEFAULT_LABEL_COLOR))
    state = JumpState(query="", label_prefix="", positions=[], labels=[], unsafe_first=set())

    with raw_terminal():
        draw(text, state, dim, label_color)
        while True:
            key = read_key()
            if key is None:
                continue
            selected_index = handle_key(key, text, keys, state)
            if selected_index == -1:
                return 0
            if selected_index is not None:
                jump_to(info, state.positions[selected_index], client_name)
                return 0
            draw(text, state, dim, label_color)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--pane", default="")
    parser.add_argument("--client", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.launch:
        return launch_popup(args.pane, args.client)
    return run_popup(args.pane, args.client)


if __name__ == "__main__":
    raise SystemExit(main())
