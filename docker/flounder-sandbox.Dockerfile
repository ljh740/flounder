FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    cargo \
    coreutils \
    curl \
    findutils \
    gawk \
    git \
    golang-go \
    grep \
    jq \
    nodejs \
    npm \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rustc \
    sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
