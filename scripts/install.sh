#!/bin/sh
# Installs or updates Patch:
#   curl -fsSL https://github.com/phongndo/patch/releases/latest/download/install.sh | sh
# Downloads a release, checks it, and has it install itself: `patchr install`
# puts the binary in ~/.local/bin and adds /patch to every harness. Arguments go
# to that command. Every release ships this script; `patchr update` reruns it.
set -eu

fail() {
  printf 'patchr: %s\n' "$*" >&2
  exit 1
}

# A function, called in a block that must be whole: half a download runs nothing.
main() {
  for tool in curl tar mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing required command: $tool"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    sum="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sum="shasum -a 256"
  else
    fail "sha256sum or shasum is needed to verify the download"
  fi

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin ;;
    Darwin-x86_64)
      target=x86_64-apple-darwin
      # A shell under Rosetta says x86_64 on Apple silicon.
      [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" != 1 ] || target=aarch64-apple-darwin
      ;;
    Linux-x86_64 | Linux-amd64) target=x86_64-unknown-linux-musl ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl ;;
    *) fail "there is no release for $(uname -s) $(uname -m); build Patch from source" ;;
  esac

  version=${PATCH_VERSION:-latest}
  if [ "$version" = latest ]; then
    # GitHub redirects to the latest release's page, which ends in its tag.
    latest=$(curl -fsSLI --retry 3 -o /dev/null -w '%{url_effective}' https://github.com/phongndo/patch/releases/latest) ||
      fail "could not look up the latest release"
    case "$latest" in
      */releases/tag/*) version=${latest##*/} ;;
      *) fail "no release has been published yet" ;;
    esac
  fi
  tag="v${version#v}"
  printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "invalid version: $version"

  package="patchr-$tag-$target"
  asset="$package.tar.gz"
  url=${PATCH_RELEASE_URL:-"https://github.com/phongndo/patch/releases/download/$tag"}
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  curl -fsSL --retry 3 "$url/$asset" -o "$temporary/$asset" || fail "could not download $url/$asset"
  curl -fsSL --retry 3 "$url/$asset.sha256" -o "$temporary/$asset.sha256" || fail "could not download the checksum"
  expected=$(awk -v name="$asset" 'NF == 2 && $2 == name && length($1) == 64 {print $1}' "$temporary/$asset.sha256")
  actual=$($sum "$temporary/$asset" | awk '{print $1}')
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    fail "the download does not match its checksum"
  fi
  tar -xzf "$temporary/$asset" -C "$temporary"
  "$temporary/$package/patchr" --version >/dev/null 2>&1 || fail "the downloaded patchr does not run on this system"
  "$temporary/$package/patchr" install "$@" </dev/null
}

{
  main "$@"
}
