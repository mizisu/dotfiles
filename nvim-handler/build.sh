#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
output_zip="$repo_root/NvimHandler.zip"
bundle_id="io.github.mizisu.NvimHandler"
signing_identity="${CODESIGN_IDENTITY:--}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/NvimHandler-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

app_path="$work_dir/NvimHandler.app"
"$script_dir/nvim-url-handler.sh" --self-test >/dev/null
/usr/bin/osacompile -o "$app_path" "$script_dir/main.applescript"
/usr/bin/install -m 755 "$script_dir/nvim-url-handler.sh" \
  "$app_path/Contents/Resources/nvim-url-handler.sh"

plist="$app_path/Contents/Info.plist"
set_plist_string() {
  local key="$1"
  local value="$2"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :$key string $value" "$plist"
}
set_plist_string CFBundleIdentifier "$bundle_id"
set_plist_string CFBundleName NvimHandler
set_plist_string CFBundleShortVersionString 1.1.0
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$plist" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string 'Neovim URL Handler'" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string nvim" "$plist"

# Script Editor adds unrelated privacy usage descriptions. This app opens Rex
# through Launch Services, so remove the broad declarations.
for key in \
  NSAppleMusicUsageDescription \
  NSCalendarsUsageDescription \
  NSCameraUsageDescription \
  NSContactsUsageDescription \
  NSHomeKitUsageDescription \
  NSMicrophoneUsageDescription \
  NSPhotoLibraryUsageDescription \
  NSRemindersUsageDescription \
  NSSiriUsageDescription \
  NSSystemAdministrationUsageDescription
do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$plist" >/dev/null 2>&1 || true
done

sign_args=(--force --deep --sign "$signing_identity")
if [[ "$signing_identity" == "-" ]]; then
  sign_args+=(--timestamp=none)
else
  sign_args+=(--options runtime --timestamp)
fi
/usr/bin/codesign "${sign_args[@]}" "$app_path"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

archive="$work_dir/NvimHandler.zip"
/usr/bin/ditto --norsrc -c -k --keepParent "$app_path" "$archive"
mv -f "$archive" "$output_zip"
printf 'Built %s with signing identity %s\n' "$output_zip" "$signing_identity"
