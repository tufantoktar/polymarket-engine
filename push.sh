#!/bin/bash
# Push Polymarket Engine to https://github.com/tufantoktar/learning_git
#
# Usage:
#   ./push.sh                    # push to main (force-push, overwrites existing)
#   ./push.sh --branch polymarket-engine   # push to a new branch instead (SAFER)
#
# Prerequisites:
#   - GitHub Personal Access Token (PAT) with "repo" scope
#     Generate: https://github.com/settings/tokens
#   - When git prompts for password, paste the TOKEN (not your GitHub password)

set -e

USERNAME="tufantoktar"
REPO="learning_git"
BRANCH="main"
FORCE=""

if [ "$1" = "--branch" ] && [ -n "$2" ]; then
  BRANCH="$2"
  echo "Mode: pushing to branch '$BRANCH' (main stays untouched)"
else
  FORCE="-f"
  echo "Mode: force-push to main (will overwrite existing repo contents)"
  echo "If learning_git has other projects, cancel (Ctrl-C) and use:"
  echo "   ./push.sh --branch polymarket-engine"
  echo ""
  read -p "Continue force-pushing to main? (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Cancelled."; exit 0
  fi
fi

echo ""
echo "=== Polymarket Engine → GitHub ==="
echo "Target: https://github.com/$USERNAME/$REPO  (branch: $BRANCH)"
echo ""

# Local git identity (only if missing)
git config user.name 2>/dev/null || git config user.name "$USERNAME"
git config user.email 2>/dev/null || git config user.email "$USERNAME@users.noreply.github.com"

# Set remote
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USERNAME/$REPO.git"

# Switch to target branch
if [ "$BRANCH" != "main" ]; then
  git checkout -B "$BRANCH"
fi

echo "Pushing... (username=$USERNAME, password=your PAT)"
echo ""
git push -u $FORCE origin "$BRANCH"

echo ""
echo "=== Done ==="
echo "View: https://github.com/$USERNAME/$REPO/tree/$BRANCH"
