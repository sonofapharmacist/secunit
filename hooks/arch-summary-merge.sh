#!/bin/bash
# Custom merge driver for auto-generated ARCHITECTURE_SUMMARY.md.
# Picks whichever version has the newer "Generated:" timestamp.
# Args: %O=base %A=ours(current) %B=theirs(incoming)
BASE="$1"
CURRENT="$2"
OTHER="$3"

get_ts() {
  grep -m1 "Generated:" "$1" 2>/dev/null | sed 's/.*Generated: //' | sed 's/ |.*//' | tr -d '[:space:]'
}

TS_CURRENT=$(get_ts "$CURRENT")
TS_OTHER=$(get_ts "$OTHER")

if [[ "$TS_OTHER" > "$TS_CURRENT" ]]; then
  cp "$OTHER" "$CURRENT"
fi

exit 0
