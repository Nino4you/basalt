#!/usr/bin/env bash
# Starts a Basalt Linux package inside a clean container of another
# distribution and checks that it is still running after a few seconds.
#
#   tools/linux_distro_smoke.sh <image> deb      <path/to/Basalt.deb>
#   tools/linux_distro_smoke.sh <image> appimage <path/to/Basalt.AppImage>
#
# The .deb is installed with the distribution's package manager, so missing
# or too new dependencies fail here. The AppImage gets only Xvfb plus the
# libraries every desktop has and AppImages deliberately leave to the host
# (GTK, Mesa/EGL, X11/Wayland clients, fontconfig, libgpg-error, gmp ...);
# minimal container images lack them. Needs docker.
set -euo pipefail

image="$1"
kind="$2"
package=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
[ -f "$package" ] || {
  echo "No package at $3" >&2
  exit 2
}

# The script below runs inside the container.
inner='
set -u
. /etc/os-release
echo "== $PRETTY_NAME, $KIND"
case "$ID" in
  debian | ubuntu)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq > /dev/null
    deps="xvfb xauth"
    [ "$KIND" = appimage ] && deps="$deps libgtk-3-0 libegl1 libgles2"
    apt-get install -y -qq $deps > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
    if [ "$KIND" = deb ]; then
      apt-get install -y -qq /package.deb > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
    fi
    ;;
  fedora)
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth which gtk3 mesa-libEGL mesa-libGLES mesa-libGL mesa-libgbm libdrm libgpg-error gmp libcom_err fribidi harfbuzz libX11-xcb libwayland-client > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
    ;;
  arch)
    pacman -Syu --noconfirm --quiet xorg-server-xvfb xorg-xauth gtk3 mesa > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
    ;;
  *)
    echo "Unsupported distribution $ID"
    exit 2
    ;;
esac
if [ "$KIND" = deb ]; then
  bin=basalt
else
  cp /package.appimage /tmp/Basalt.AppImage && chmod +x /tmp/Basalt.AppImage
  bin=/tmp/Basalt.AppImage
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
timeout 20 xvfb-run -a "$bin" > /tmp/run.log 2>&1
result=$?
grep -v "DRI3\|libEGL" /tmp/run.log | tail -20
if [ "$result" -eq 124 ]; then
  echo "OK: Basalt was still running after 20 s"
else
  echo "FAILED: Basalt exited with code $result"
  exit 1
fi
'
docker run --rm -e KIND="$kind" -v "$package:/package.$kind:ro" "$image" bash -c "$inner"
