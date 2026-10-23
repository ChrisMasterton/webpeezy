#!/bin/bash
# Generate all required icon sizes from source.png

SOURCE="source.png"
if [ ! -f "$SOURCE" ]; then
    echo "source.png not found"
    exit 1
fi

# Create iconset directory for macOS
mkdir -p icon.iconset

# Generate PNG sizes for Tauri
sips -z 32 32 "$SOURCE" --out 32x32.png
sips -z 128 128 "$SOURCE" --out 128x128.png
sips -z 256 256 "$SOURCE" --out "128x128@2x.png"
sips -z 512 512 "$SOURCE" --out icon.png

# Generate iconset for macOS .icns
sips -z 16 16 "$SOURCE" --out icon.iconset/icon_16x16.png
sips -z 32 32 "$SOURCE" --out icon.iconset/icon_16x16@2x.png
sips -z 32 32 "$SOURCE" --out icon.iconset/icon_32x32.png
sips -z 64 64 "$SOURCE" --out icon.iconset/icon_32x32@2x.png
sips -z 128 128 "$SOURCE" --out icon.iconset/icon_128x128.png
sips -z 256 256 "$SOURCE" --out icon.iconset/icon_128x128@2x.png
sips -z 256 256 "$SOURCE" --out icon.iconset/icon_256x256.png
sips -z 512 512 "$SOURCE" --out icon.iconset/icon_256x256@2x.png
sips -z 512 512 "$SOURCE" --out icon.iconset/icon_512x512.png
sips -z 1024 1024 "$SOURCE" --out icon.iconset/icon_512x512@2x.png

# Generate .icns from iconset
iconutil -c icns icon.iconset -o icon.icns

# Generate Windows store logos
sips -z 30 30 "$SOURCE" --out Square30x30Logo.png
sips -z 44 44 "$SOURCE" --out Square44x44Logo.png
sips -z 71 71 "$SOURCE" --out Square71x71Logo.png
sips -z 89 89 "$SOURCE" --out Square89x89Logo.png
sips -z 107 107 "$SOURCE" --out Square107x107Logo.png
sips -z 142 142 "$SOURCE" --out Square142x142Logo.png
sips -z 150 150 "$SOURCE" --out Square150x150Logo.png
sips -z 284 284 "$SOURCE" --out Square284x284Logo.png
sips -z 310 310 "$SOURCE" --out Square310x310Logo.png
sips -z 50 50 "$SOURCE" --out StoreLogo.png

# Clean up
rm -rf icon.iconset

echo "Icons generated successfully!"
