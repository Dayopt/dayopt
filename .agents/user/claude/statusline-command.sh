#!/bin/sh
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd')
printf "%s:%s \033[32m %s\033[0m" "$(whoami)" "$(date +%H:%M:%S)" "$(basename "$cwd")"
