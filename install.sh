#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Instinct Coder: $*" >&2
  exit 1
}

download() {
  curl --fail --silent --show-error --location --retry 2 "$1" --output "$2"
}

verified_download() {
  download "$1" "$2"
  if command -v sha256sum >/dev/null 2>&1; then
    checksum=$(sha256sum < "$2")
  else
    checksum=$(shasum -a 256 < "$2")
  fi
  [ "${checksum%% *}" = "$3" ] || fail "Checksum mismatch for ${1##*/}."
}

choose_platform() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64)
      platform=linux arch=x64 wa_arch=amd64
      open_asset=opencode-linux-x64-baseline.tar.gz
      open_sha=8443113b3f3dfebf8b0fa91c4377e5519a62b9231732d9344a5df001e4a852b3
      node_sha=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2
      wa_sha=515405c5a33c7f651a368484740db662736f50c275be5a0504fb0a84dce47013
      ;;
    Linux:arm64|Linux:aarch64)
      platform=linux arch=arm64 wa_arch=arm64
      open_asset=opencode-linux-arm64.tar.gz
      open_sha=5b68c1f4c5e75b4134e664cc8f36d634d64208d4fcfe5bcf3b48bab699c2dbac
      node_sha=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8
      wa_sha=9efe789b01e12462140089749d8b5ce0ad292521893f4166e13eca81f0acac4c
      ;;
    Darwin:x86_64)
      platform=darwin arch=x64 wa_arch=amd64
      open_asset=opencode-darwin-x64-baseline.zip
      open_sha=5f08d3f7d7555fdef8025f57aef89c5bc2448460827d4e225f815a308ce6976b
      node_sha=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7
      wa_sha=d5561a41534ec83be8bca611d1fcef12bbfb9967a3661dcc7d0328b929224a7d
      ;;
    Darwin:arm64)
      platform=darwin arch=arm64 wa_arch=arm64
      open_asset=opencode-darwin-arm64.zip
      open_sha=c0be3f34dde2fdcb31b25120f303c6ed5b69b828f16e5e0fbecff21a882adda1
      node_sha=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
      wa_sha=20898523a70fb3ad992f8a20d786f70484bb53221df017cdafdcb7f7fc882d8f
      ;;
    *) fail 'This installer supports Linux and macOS on x86-64 and ARM64.' ;;
  esac
}

install_tools() {
  mkdir -p "$tools"
  if [ ! -x "$tools/node" ]; then
    printf '%s\n' 'Installing Node.js…'
    node_archive="node-v$node_version-$platform-$arch"
    verified_download "https://nodejs.org/dist/v$node_version/$node_archive.tar.gz" "$stage/node.tar.gz" "$node_sha"
    tar -xzf "$stage/node.tar.gz" -C "$stage" "$node_archive/bin/node"
    mv -f "$stage/$node_archive/bin/node" "$tools/node"
  fi
  if [ ! -x "$tools/opencode" ]; then
    printf '%s\n' 'Installing OpenCode…'
    mkdir -p "$stage/opencode"
    verified_download "https://github.com/anomalyco/opencode/releases/download/v$opencode_version/$open_asset" "$stage/$open_asset" "$open_sha"
    case "$open_asset" in
      *.zip) unzip -q "$stage/$open_asset" -d "$stage/opencode" ;;
      *) tar -xzf "$stage/$open_asset" -C "$stage/opencode" ;;
    esac
    chmod +x "$stage/opencode/opencode"
    mv -f "$stage/opencode/opencode" "$tools/opencode"
  fi
  if [ ! -x "$tools/wacli" ]; then
    printf '%s\n' 'Installing the WhatsApp connector…'
    mkdir -p "$stage/wacli"
    wa_asset="wacli_${wacli_version}_${platform}_$wa_arch.tar.gz"
    verified_download "https://github.com/openclaw/wacli/releases/download/v$wacli_version/$wa_asset" "$stage/$wa_asset" "$wa_sha"
    tar -xzf "$stage/$wa_asset" -C "$stage/wacli"
    mv -f "$stage/wacli/wacli" "$tools/wacli"
  fi
  "$tools/node" --version >/dev/null || fail 'Node.js could not run on this machine.'
  "$tools/opencode" --version >/dev/null || fail 'OpenCode could not run on this machine.'
  "$tools/wacli" version >/dev/null || fail 'The WhatsApp connector could not run on this machine.'
}

cleanup() {
  if [ -n "${stage:-}" ]; then rm -rf -- "$stage"; fi
  if [ -n "${link_stage:-}" ]; then rm -rf -- "$link_stage"; fi
}

main() {
  umask 077
  choose_platform
  command -v curl >/dev/null 2>&1 || fail 'Install curl and run this command again.'
  command -v tar >/dev/null 2>&1 || fail 'Install tar and run this command again.'
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail 'A SHA-256 checksum tool is required.'
  fi
  if [ "$platform" = darwin ]; then
    command -v unzip >/dev/null 2>&1 || fail 'Install unzip and run this command again.'
  fi

  node_version=24.22.3 opencode_version=1.19.6 wacli_version=0.26.1
  ref=${INSTINCT_CODER_REF:-main}
  case "$ref" in *[!a-zA-Z0-9._-]*) fail 'The source ref must be a branch, tag, or commit without slashes.' ;; esac
  install_dir=${INSTINCT_CODER_INSTALL_DIR:-${XDG_DATA_HOME:-"$HOME/.local/share"}/instinct-coder}
  bin_dir=${INSTINCT_CODER_BIN_DIR:-"$HOME/.local/bin"}
  mkdir -p "$install_dir/releases" "$bin_dir"
  install_dir=$(cd "$install_dir" && pwd -P)
  bin_dir=$(cd "$bin_dir" && pwd -P)
  releases="$install_dir/releases"
  tools="$install_dir/tools/$node_version-$opencode_version-$wacli_version-$platform-$arch"
  launcher="$bin_dir/instinct-coder"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    case "$(readlink "$launcher" || true)" in
      "$releases"/*/launch) ;;
      *) fail "Another installation is present at $launcher." ;;
    esac
  fi

  stage=$(mktemp -d "$releases/.install.XXXXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '%s\n' 'Downloading Instinct Coder…'
  download "https://codeload.github.com/alexechoi/instinct-coder/tar.gz/$ref" "$stage/source.tar.gz"
  mkdir "$stage/app"
  tar -xzf "$stage/source.tar.gz" -C "$stage/app" --strip-components=1
  [ -f "$stage/app/src/cli.js" ] || fail 'The downloaded revision does not include the setup command.'
  install_tools
  release="$releases/${stage##*.}"
  ln -s "$tools" "$stage/app/bin"
  cat > "$stage/app/launch" <<'LAUNCH'
#!/bin/sh
set -eu
script=$0
if [ -L "$script" ]; then script=$(readlink "$script"); fi
root=$(CDPATH='' cd -- "$(dirname -- "$script")" && pwd)
export INSTINCT_CODER_COMMAND="$0"
exec "$root/bin/node" "$root/src/cli.js" "$@"
LAUNCH
  chmod +x "$stage/app/launch"
  mv "$stage/app" "$release"
  link_stage=$(mktemp -d "$bin_dir/.instinct-coder.XXXXXXXX")
  ln -s "$release/launch" "$link_stage/instinct-coder"
  if [ -d "$launcher" ]; then fail "Cannot replace the directory at $launcher."; fi
  mv -f "$link_stage/instinct-coder" "$launcher"
  printf '\n%s\n' 'Instinct Coder is installed. Link WhatsApp with:'
  if [ "$launcher" = "$HOME/.local/bin/instinct-coder" ]; then
    printf '  %s\n' '~/.local/bin/instinct-coder setup'
  else
    printf '  "%s" setup\n' "$launcher"
  fi
}

main "$@"
