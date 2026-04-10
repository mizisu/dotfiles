#!/bin/bash
# Sync visual-explainer from upstream and install Pi prompts.
# Usage:
#   bash ~/.pi/agent/skills/vi-sync.sh           # sync latest origin/main
#   bash ~/.pi/agent/skills/vi-sync.sh v0.6.3    # sync a specific ref/tag

set -euo pipefail

REPO_URL="https://github.com/nicobailon/visual-explainer.git"
UPSTREAM_DIR="$HOME/.pi/agent/git/github.com/nicobailon/visual-explainer"
SKILL_DIR="$HOME/.pi/agent/skills/visual-explainer"
PROMPTS_DIR="$HOME/.pi/agent/prompts"
PROMPT_PREFIX="vi-"
REF="${1:-origin/main}"

COMMAND_NAMES=(
  diff-review
  fact-check
  generate-slides
  generate-visual-plan
  generate-web-diagram
  plan-review
  project-recap
  share
)

clone_or_update_repo() {
  mkdir -p "$(dirname "$UPSTREAM_DIR")"

  if [ ! -d "$UPSTREAM_DIR/.git" ]; then
    echo "Cloning visual-explainer..."
    git clone "$REPO_URL" "$UPSTREAM_DIR"
  fi

  echo "Fetching upstream..."
  git -C "$UPSTREAM_DIR" fetch --tags --prune origin

  if [ "$REF" = "origin/main" ]; then
    if git -C "$UPSTREAM_DIR" show-ref --verify --quiet refs/heads/main; then
      git -C "$UPSTREAM_DIR" checkout --force main >/dev/null
    else
      git -C "$UPSTREAM_DIR" checkout --force -b main origin/main >/dev/null
    fi
    git -C "$UPSTREAM_DIR" reset --hard origin/main >/dev/null
  else
    git -C "$UPSTREAM_DIR" checkout --detach --force "$REF" >/dev/null
  fi
}

copy_skill() {
  local src_dir="$UPSTREAM_DIR/plugins/visual-explainer"

  if [ ! -f "$src_dir/SKILL.md" ]; then
    echo "ERROR: visual-explainer skill not found at $src_dir"
    exit 1
  fi

  rm -rf "$SKILL_DIR"
  mkdir -p "$SKILL_DIR"
  cp -R "$src_dir"/. "$SKILL_DIR"/
}

patch_disable_model_invocation() {
  local skill_md="$SKILL_DIR/SKILL.md"

  if ! rg -q '^disable-model-invocation: true$' "$skill_md"; then
    awk '
      BEGIN { added = 0; frontmatter = 0 }
      /^---$/ {
        if (frontmatter == 0) {
          frontmatter = 1
          print
          next
        }
        if (frontmatter == 1 && added == 0) {
          print "disable-model-invocation: true"
          added = 1
          frontmatter = 2
        }
        print
        next
      }
      { print }
    ' "$skill_md" > "$skill_md.tmp"
    mv "$skill_md.tmp" "$skill_md"
  fi
}

patch_skill_dir_placeholders() {
  if [[ "$OSTYPE" == darwin* ]]; then
    find "$SKILL_DIR" -name '*.md' -exec sed -i '' "s|{{skill_dir}}|$SKILL_DIR|g" {} \;
  else
    find "$SKILL_DIR" -name '*.md' -exec sed -i "s|{{skill_dir}}|$SKILL_DIR|g" {} \;
  fi
}

patch_skill_note() {
  local skill_md="$SKILL_DIR/SKILL.md"
  local old_text='Detailed prompt templates in `./commands/`. In Pi, these are slash commands (`/diff-review`). In Claude Code, namespaced (`/visual-explainer:diff-review`). In Codex, use `/prompts:diff-review` (if installed to `~/.codex/prompts/`) or invoke `$visual-explainer` and describe the workflow.'
  local new_text='Detailed prompt templates in `./commands/`. In this Pi setup, the installed slash command aliases use the `vi-` prefix (for example, `/vi-diff-review`). In Claude Code, commands remain namespaced (`/visual-explainer:diff-review`). In Codex, use `/prompts:diff-review` (if installed to `~/.codex/prompts/`) or invoke `$visual-explainer` and describe the workflow.'

  if rg -q 'In Pi, these are slash commands' "$skill_md"; then
    OLD_TEXT="$old_text" NEW_TEXT="$new_text" perl -0pi -e 's/\Q$ENV{OLD_TEXT}\E/$ENV{NEW_TEXT}/g' "$skill_md"
  fi
}

install_prompts() {
  mkdir -p "$PROMPTS_DIR"

  for name in "${COMMAND_NAMES[@]}"; do
    rm -f "$PROMPTS_DIR/$name.md" "$PROMPTS_DIR/$PROMPT_PREFIX$name.md"
  done

  for prompt in "$SKILL_DIR"/commands/*.md; do
    [ -f "$prompt" ] || continue

    local base
    base="$(basename "$prompt")"

    cp "$prompt" "$PROMPTS_DIR/$PROMPT_PREFIX$base"
  done
}

patch_prefixed_prompt_usages() {
  for prompt in "$PROMPTS_DIR"/"$PROMPT_PREFIX"*.md; do
    [ -f "$prompt" ] || continue

    for command_name in "${COMMAND_NAMES[@]}"; do
      perl -0pi -e "s#(?<![[:alnum:]_.-])/${command_name}(?=(?:[[:space:]\`<),.:;!?]|$))#/${PROMPT_PREFIX}${command_name}#g" "$prompt"
    done
  done
}

print_summary() {
  local commit version
  commit="$(git -C "$UPSTREAM_DIR" rev-parse --short HEAD)"
  version="$(rg '^  version:' "$SKILL_DIR/SKILL.md" | head -1 | sed 's/^  version: //')"

  echo ""
  echo "Synced visual-explainer from $REF ($commit)"
  echo "Skill version: $version"
  echo "Skill dir:  $SKILL_DIR"
  echo "Prompts dir: $PROMPTS_DIR"
  echo ""
  echo "Use prefixed commands like:"
  echo "  /vi-diff-review"
  echo "  /vi-plan-review"
  echo "  /vi-project-recap"
  echo "  /vi-generate-web-diagram"
}

clone_or_update_repo
copy_skill
patch_disable_model_invocation
patch_skill_dir_placeholders
patch_skill_note
install_prompts
patch_prefixed_prompt_usages
print_summary
