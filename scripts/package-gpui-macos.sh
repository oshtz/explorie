#!/usr/bin/env bash
set -euo pipefail

repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(node -p "require('$repository/package.json').version")
target=${EXPLORIE_MACOS_TARGET:-aarch64-apple-darwin}
identity=${APPLE_SIGNING_IDENTITY:--}
team_id=${APPLE_TEAM_ID:-}
assets="$repository/apps/desktop/native-assets"
binary="$repository/target/$target/release/explorie-gpui"
bundle_root="$repository/target/release/bundle"
app="$bundle_root/macos/explorie.app"
dmg_root="$bundle_root/dmg-root"
dmg="$bundle_root/dmg/explorie_${version}_${target}.dmg"
rclone="$assets/binaries/rclone-$target"
helper="$assets/macos/build/explorie-mountd"

case "$app:$dmg_root" in
  "$repository"/target/release/bundle/*:"$repository"/target/release/bundle/*) ;;
  *) echo "Package paths escaped the release bundle root." >&2; exit 1 ;;
esac

case "$target" in
  aarch64-apple-darwin) architecture=arm64 ;;
  x86_64-apple-darwin) architecture=x86_64 ;;
  *) echo "Unsupported macOS package target: $target" >&2; exit 1 ;;
esac

test -x "$binary"
test -x "$rclone"
test -f "$assets/icons/icon.icns"
test -f "$assets/resources/rclone-COPYING"
test -f "$assets/resources/pixelarticons-LICENSE.txt"
test -f "$assets/macos/MountDaemon.m"
test -f "$assets/macos/com.omershatz.explorie.mountd.plist"

mkdir -p "$(dirname "$helper")"
xcrun clang \
  -arch "$architecture" \
  -fobjc-arc \
  -fblocks \
  -mmacosx-version-min=13.0 \
  -framework Foundation \
  -framework Security \
  "-DEXPLORIE_TEAM_ID=\"$team_id\"" \
  "$assets/macos/MountDaemon.m" \
  -o "$helper"

rm -rf "$app" "$dmg_root"
mkdir -p \
  "$app/Contents/MacOS" \
  "$app/Contents/Resources/licenses" \
  "$app/Contents/Library/LaunchDaemons" \
  "$bundle_root/dmg" \
  "$dmg_root"

install -m 755 "$binary" "$app/Contents/MacOS/explorie-gpui"
install -m 755 "$rclone" "$app/Contents/MacOS/rclone"
install -m 755 "$helper" "$app/Contents/Resources/explorie-mountd"
install -m 644 "$assets/icons/icon.icns" "$app/Contents/Resources/icon.icns"
install -m 644 "$assets/resources/rclone-COPYING" "$app/Contents/Resources/licenses/rclone-COPYING"
install -m 644 \
  "$assets/resources/pixelarticons-LICENSE.txt" \
  "$app/Contents/Resources/licenses/pixelarticons-LICENSE.txt"
install -m 644 \
  "$assets/macos/com.omershatz.explorie.mountd.plist" \
  "$app/Contents/Library/LaunchDaemons/com.omershatz.explorie.mountd.plist"

cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>explorie</string>
  <key>CFBundleExecutable</key><string>explorie-gpui</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>com.omershatz.explorie</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>explorie</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Library/LaunchDaemons/com.omershatz.explorie.mountd.plist"

sign() {
  local identifier=$1
  local path=$2
  local arguments=(--force --options runtime --identifier "$identifier" --sign "$identity")
  if [ "$identity" != "-" ]; then arguments+=(--timestamp); fi
  codesign "${arguments[@]}" "$path"
}

sign com.omershatz.explorie.mountd "$app/Contents/Resources/explorie-mountd"
sign com.omershatz.explorie.rclone "$app/Contents/MacOS/rclone"
sign com.omershatz.explorie "$app/Contents/MacOS/explorie-gpui"
sign com.omershatz.explorie "$app"
codesign --verify --deep --strict --verbose=2 "$app"

ditto "$app" "$dmg_root/explorie.app"
ln -s /Applications "$dmg_root/Applications"
rm -f "$dmg"
hdiutil create \
  -volname explorie \
  -srcfolder "$dmg_root" \
  -ov \
  -format UDZO \
  "$dmg"
test -s "$dmg"
printf '%s\n' "$dmg"
