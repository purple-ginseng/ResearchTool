#!/bin/bash
# Store your Overleaf Git token with git's credential helper (the macOS Keychain, the Windows Credential Manager, or
# libsecret on Linux), so ResearchTool (through git) can sync with Overleaf.
# Usage: scripts/overleaf-login.sh <overleaf-project-id-or-url>      (on Windows: run it in Git Bash)
# This script never reads, prints, stores or logs the token: git asks for it and hands it to its credential helper.
set -u

BASE="${RT_OVERLEAF_GIT_BASE:-https://git.overleaf.com}"
BASE="${BASE%/}"

arg="${1:-}"
id=""
if [[ "$arg" =~ ^[0-9a-fA-F]{24}$ ]]; then
  id="$arg"
elif [[ "$arg" =~ ^https://(www\.)?overleaf\.com/project/([0-9a-fA-F]{24})([/?#].*)?$ ]]; then
  id="${BASH_REMATCH[2]}"
elif [[ "$arg" =~ ^https://(git@)?git\.overleaf\.com/([0-9a-fA-F]{24})(\.git)?/?$ ]]; then
  id="${BASH_REMATCH[2]}"
fi
if [[ -z "$id" ]]; then
  echo "Usage: $0 <overleaf-project-id-or-url>" >&2
  echo "  e.g. $0 https://www.overleaf.com/project/0123456789abcdef01234567" >&2
  exit 2
fi
id="$(printf '%s' "$id" | tr 'A-F' 'a-f')"
url="$BASE/$id"

case "$(uname -s)" in
  Darwin) os=mac; store="the macOS Keychain"; helper=osxkeychain ;;
  MINGW*|MSYS*|CYGWIN*) os=windows; store="the Windows Credential Manager"; helper=manager ;;
  *) os=linux; store="your git credential helper"; helper="" ;;
esac

if ! command -v git >/dev/null 2>&1; then
  case "$os" in
    mac) echo "git is not installed. Run: xcode-select --install" >&2 ;;
    windows) echo "git is not installed. Install Git for Windows: https://git-scm.com/download/win" >&2 ;;
    *) echo "git is not installed. Install it with your package manager, e.g.: sudo apt install git" >&2 ;;
  esac
  exit 1
fi
if [[ "$os" == linux && -x "$(git --exec-path 2>/dev/null)/git-credential-libsecret" ]]; then
  helper=libsecret; store="the desktop keyring (libsecret)"
fi

echo "This asks git to contact Overleaf once ($url)."
echo "git will ask for a username and a password and save them in $store; this script never sees them."
echo

if [[ -z "$(git config --get-all credential.helper 2>/dev/null)" ]]; then
  if [[ -z "$helper" ]]; then
    echo "No git credential helper is configured, so git would not keep the token. Configure one first, for example:" >&2
    echo "  git config --global credential.helper libsecret   (needs the git-credential-libsecret package)" >&2
    echo "  git config --global credential.helper 'cache --timeout=604800'   (kept in memory for a week)" >&2
    echo "then run this again." >&2
    exit 1
  fi
  git config --global credential.helper "$helper"
  echo "No git credential helper was configured, so I set:  git config --global credential.helper $helper"
  echo
else
  echo "Using your existing git credential helper: $(git config --get-all credential.helper | tail -n 1)"
  echo
fi

echo "When asked:"
echo "  Username: type  git"
echo "  Password: paste your Overleaf Git token (Overleaf > Account Settings > Git integration); nothing is shown while you paste"
echo

try() { GIT_TERMINAL_PROMPT=1 git ls-remote --heads -- "$url" >/dev/null; }

if try; then
  ok=1
else
  ok=0
  echo
  echo "That did not work. If an old or mistyped token was saved, git has removed it now. Trying once more:"
  echo
  if try; then ok=1; fi
fi

echo
if [[ "$ok" == 1 ]]; then
  echo "Success: the token is now stored in $store. You can return to ResearchTool and click \"Try again\"."
  exit 0
fi
echo "Could not log in to Overleaf. Check that:" >&2
echo "  - the project link is right and you can open it on Overleaf," >&2
echo "  - the token was created under Account Settings > Git integration and has not expired," >&2
echo "  - you are online." >&2
exit 1
