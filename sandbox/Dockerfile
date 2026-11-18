# Orqestra's Sandbox: an Ubuntu 24.04 platform Snapshot plus git, gh and the Python packages Skills use.
# `base` is that platform Snapshot; scripts/sandbox-snapshot.sh names it. It may be a bare ubuntu:24.04 without curl or git.
FROM base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh python3-pypdf python3-openpyxl python3-docx python3-pandas \
 && rm -rf /var/lib/apt/lists/*
