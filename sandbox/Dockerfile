# Orqestra's Sandbox: Orrery's platform image (Ubuntu 24.04 with git, curl, Python 3, Node, …) plus gh and the Python packages Skills use.
# `base` is that platform Snapshot; scripts/sandbox-snapshot.sh names it.
FROM base
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh python3-pypdf python3-openpyxl python3-docx python3-pandas \
 && rm -rf /var/lib/apt/lists/*
