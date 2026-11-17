#!/usr/bin/env bash
set -euo pipefail

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"
: "${DJ_SOURCE_PASSWORD:?DJ_SOURCE_PASSWORD is required}"
: "${DJ_HARBOR_PORT:=8005}"
: "${JUKEBOX_BITRATE:=320}"
: "${JUKEBOX_ICECAST_HOST:=icecast}"
: "${JUKEBOX_ICECAST_PORT:=8000}"
: "${JUKEBOX_MOUNT:=/radio.mp3}"
: "${JUKEBOX_NAME:=Virgo Boys Radio Jukebox}"
: "${JUKEBOX_DESCRIPTION:=Virgo Boys Radio local MP3 jukebox}"
: "${JUKEBOX_GENRE:=Eclectic}"
: "${JUKEBOX_MEDIA_DIR:=/music}"
: "${JUKEBOX_PLAYLIST_MODE:=randomize}"

export DJ_SOURCE_PASSWORD
export DJ_HARBOR_PORT
export JUKEBOX_BITRATE
export ICECAST_SOURCE_PASSWORD
export JUKEBOX_ICECAST_HOST
export JUKEBOX_ICECAST_PORT
export JUKEBOX_MOUNT
export JUKEBOX_NAME
export JUKEBOX_DESCRIPTION
export JUKEBOX_GENRE
export JUKEBOX_MEDIA_DIR
export JUKEBOX_PLAYLIST_MODE

mkdir -p /tmp/liquidsoap
envsubst < /etc/liquidsoap/radio.liq.template > /tmp/liquidsoap/radio.liq

exec liquidsoap /tmp/liquidsoap/radio.liq
