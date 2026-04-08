#!/bin/bash
# Sync gstack skills to ~/.pi/agent/skills/ with gst- prefix
# Usage: bash ~/.pi/agent/skills/gst-sync.sh
# Run after: cd ~/.pi/agent/git/github.com/garrytan/gstack && git pull

set -euo pipefail

GSTACK_DIR="$HOME/.pi/agent/git/github.com/garrytan/gstack"
SKILLS_DIR="$HOME/.pi/agent/skills"
PREFIX="gst"

if [ ! -d "$GSTACK_DIR" ]; then
  echo "ERROR: gstack not found at $GSTACK_DIR"
  echo "Run: git clone https://github.com/garrytan/gstack.git $GSTACK_DIR"
  exit 1
fi

# Update gstack
echo "Pulling latest gstack..."
cd "$GSTACK_DIR" && git pull --ff-only 2>/dev/null || true

# Find all skill directories (contain SKILL.md, exclude nested openclaw skills and root)
skill_dirs=()
for skill_md in "$GSTACK_DIR"/*/SKILL.md; do
  [ -f "$skill_md" ] || continue
  skill_dir="$(dirname "$skill_md")"
  skill_name="$(basename "$skill_dir")"
  skill_dirs+=("$skill_name")
done

echo "Found ${#skill_dirs[@]} skills"

synced=0
for skill_name in "${skill_dirs[@]}"; do
  src_dir="$GSTACK_DIR/$skill_name"

  # Determine target name: if already prefixed with gstack-, replace with gst-
  # Otherwise prepend gst-
  if [[ "$skill_name" == gstack-* ]]; then
    target_name="${PREFIX}-${skill_name#gstack-}"
  else
    target_name="${PREFIX}-${skill_name}"
  fi

  target_dir="$SKILLS_DIR/$target_name"

  # Create target directory
  mkdir -p "$target_dir"

  # Copy SKILL.md with modified name field
  sed -E "s/^name: .+$/name: ${target_name}/" "$src_dir/SKILL.md" > "$target_dir/SKILL.md"

  # Symlink all other files/directories (skip SKILL.md)
  for item in "$src_dir"/*; do
    item_name="$(basename "$item")"
    [ "$item_name" = "SKILL.md" ] && continue
    [ "$item_name" = "SKILL.md.tmpl" ] && continue

    target_item="$target_dir/$item_name"
    # Remove existing symlink or file
    rm -rf "$target_item"
    ln -s "$item" "$target_item"
  done

  synced=$((synced + 1))
  echo "  ✓ $skill_name → $target_name"
done

echo ""
echo "Synced $synced skills with '$PREFIX-' prefix"
echo "Restart pi to pick up new skills"
