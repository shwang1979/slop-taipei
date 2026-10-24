#!/bin/bash
# usage: tools/fetch-osm.sh — downloads the OpenStreetMap extracts build-geodata.mjs reads (about 75 MB) into tools/data
set -euo pipefail
cd "$(dirname "$0")"
for q in roads areas rail nodes districts buildings; do
  ./overpass.sh "data/osm_$q.json" "data/q_$q.overpassql" 6
done
