#!/bin/bash
#
# build.sh - Production Build Script
#
# This script builds WebPeezy for distribution.
# It creates a .app bundle and DMG installer for macOS.
#
# Output: src-tauri/target/release/bundle/
#   - dmg/WebPeezy_<version>_<arch>.dmg
#   - macos/WebPeezy.app
#
# Usage: ./build.sh
#

set -e

echo "WebPeezy - Production Build"
echo "==========================="
echo

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Error: Dependencies not installed."
    echo "Run ./install.sh first."
    exit 1
fi

echo "Building frontend..."
npm run build

echo
echo "Building Tauri app..."
npm run tauri:build

echo
echo "Build complete!"
echo
echo "Output files:"
ls -la src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || echo "  (no DMG found)"
ls -la src-tauri/target/release/bundle/macos/*.app 2>/dev/null || echo "  (no .app found)"
