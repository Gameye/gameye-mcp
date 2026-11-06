# Source: gameye-skills v1.6.1, skills/gameye-containerize/SKILL.md, Dockerfile pattern (MIT License, Copyright (c) 2026 Gameye B.V.).
# Copied verbatim below this header as a golden clean case.
# ── Build/fetch stage: toolchains and downloads stay out of the runtime image ──
FROM debian:bookworm-slim AS build
# ... fetch or compile the dedicated server, strip client-only assets ...

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# Unique per build, so registry webhooks fire even for identical content
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

# Non-root user
RUN groupadd --system --gid 10001 game \
 && useradd  --system --uid 10001 --gid game --no-create-home \
             --shell /usr/sbin/nologin game

WORKDIR /server
COPY --from=build --chown=game:game /out/ /server/
COPY --chown=game:game entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER game

# Must match the application's port bindings in the Gameye Admin Panel
EXPOSE 7777/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
