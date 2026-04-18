#!/bin/bash
# Polymarket Engine — GitHub Push Script
# Usage: ./push.sh <github-username>
#
# Prerequisites:
#   1. Create an empty repo at https://github.com/new → name: polymarket-engine
#   2. Have a GitHub Personal Access Token (PAT) ready
#      → GitHub → Settings → Developer Settings → Personal Access Tokens → Generate
#      → Scope: "repo" is enough
#
# This script will push the full repo with 2 commits (V4.3.1 + V4.3.2)

set -e

if [ -z "$1" ]; then
  echo "Usage: ./push.sh <github-username>"
  echo "Example: ./push.sh myuser"
  exit 1
fi

USERNAME="$1"
REPO="polymarket-engine"

echo "=== Polymarket Engine Push ==="
echo "Target: https://github.com/$USERNAME/$REPO"
echo ""

# Set git identity if not already set
git config user.name 2>/dev/null || git config user.name "$USERNAME"
git config user.email 2>/dev/null || git config user.email "$USERNAME@users.noreply.github.com"

# Add remote (remove first if exists)
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USERNAME/$REPO.git"

echo "Pushing to GitHub..."
echo "(GitHub will ask for username + token as password)"
echo ""

git push -u origin main

echo ""
echo "=== Done! ==="
echo "View at: https://github.com/$USERNAME/$REPO"
