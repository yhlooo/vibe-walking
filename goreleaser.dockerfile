FROM ubuntu:24.04
ARG TARGETPLATFORM

# 装入与目标镜像平台匹配的发布二进制。
COPY $TARGETPLATFORM/vibe-walking /usr/bin/vibe-walking

ENTRYPOINT ["/usr/bin/vibe-walking"]
