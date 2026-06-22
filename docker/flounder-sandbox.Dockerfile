FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    cmake \
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
    ninja-build \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rustc \
    sed \
  && rm -rf /var/lib/apt/lists/*

ARG FOUNDRY_VERSION=stable
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="${FOUNDRY_DIR}/bin:${PATH}"

RUN curl -L https://foundry.paradigm.xyz | bash \
  && if [ "$FOUNDRY_VERSION" = "stable" ]; then foundryup; else foundryup --install "$FOUNDRY_VERSION"; fi \
  && ln -sf "${FOUNDRY_DIR}/bin/forge" /usr/local/bin/forge \
  && ln -sf "${FOUNDRY_DIR}/bin/cast" /usr/local/bin/cast \
  && ln -sf "${FOUNDRY_DIR}/bin/anvil" /usr/local/bin/anvil \
  && ln -sf "${FOUNDRY_DIR}/bin/chisel" /usr/local/bin/chisel \
  && forge --version \
  && cast --version \
  && anvil --version

WORKDIR /workspace
