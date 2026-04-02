#!/bin/bash

DIR="data/hls"

for d in "$DIR"/*; do
    [ -d "$d" ] || continue

    abs_path=$(realpath "$d")
    b64=$(basename "$d")
    real=$(echo "$b64" | tr '_-' '/+' | base64 --decode 2>/dev/null)

    echo "$abs_path -> $real"
done

