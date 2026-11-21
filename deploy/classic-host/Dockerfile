# Headless SOS: Classic listen host under Wine (no Steam: the host runs fine with SteamAPI init failing).
# Holds no game files: /game is a bind mount of a private copy (see docs/LINUX_HOST.md). Never push this image.
FROM ubuntu:24.04

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      wine wine64 xvfb xauth openssl curl ca-certificates procps tini \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 (the image's "ubuntu" user) owns the prefix and the game copy on the host disk.
ENV HOME=/home/ubuntu WINEPREFIX=/home/ubuntu/prefix WINEARCH=win64 WINEDEBUG=-all \
    WINEDLLOVERRIDES="version=n,b;mscoree,mshtml=" DISPLAY=:99
COPY entrypoint.sh /usr/local/bin/ogsos-host
RUN chmod 755 /usr/local/bin/ogsos-host
USER ubuntu
WORKDIR /home/ubuntu
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ogsos-host"]
