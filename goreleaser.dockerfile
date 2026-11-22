FROM ubuntu:24.04
ARG TARGETPLATFORM
COPY $TARGETPLATFORM/vibe-walking /usr/bin/vibe-walking
ENTRYPOINT ["/usr/bin/vibe-walking"]
