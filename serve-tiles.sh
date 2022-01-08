#!/usr/bin/env bash

cd "$(dirname "$0")"

INPUT_DIR=/Volumes/ExFat/Boven.land/data/fifteen-minutes

tessella --port 7567 mbtiles://$INPUT_DIR/analyzed.mbtiles
