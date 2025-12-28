#!/bin/bash
#
# install.sh - Development Environment Setup
#
# This script prepares your machine for WebPeezy development.
# It checks for required tools and installs npm dependencies.
#
# Usage: ./install.sh
#

set -e

echo "WebPeezy - Development Setup"
echo "============================"
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi
echo "Node.js $(node -v) found"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    exit 1
fi
echo "npm $(npm -v) found"

# Check for Rust/Cargo (required for Tauri)
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust is not installed."
    echo "Please install Rust from https://rustup.rs/"
    exit 1
fi
echo "Cargo $(cargo -V | cut -d' ' -f2) found"

echo
echo "Installing dependencies..."
npm install

echo
echo "Installation complete!"
echo
echo "To run the app in development mode:"
echo "  npm run tauri:dev"
echo
echo "To build for production:"
echo "  npm run tauri:build"
