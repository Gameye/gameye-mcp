# Source: gameye-skills v1.7.0, skills/gameye-godot-server/SKILL.md, Container specifics (MIT License, Copyright (c) 2026 Gameye B.V.).
# Copied verbatim below this header as a golden clean case.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 game \
 && useradd --system --uid 10001 --gid game --no-create-home --shell /usr/sbin/nologin game
WORKDIR /server
COPY --chown=game:game build/game-server.x86_64 build/game-server.pck /server/
# Godot ignores SIGTERM as PID 1 and dies without cleanup as a child, so this
# wrapper is PID 1: it turns SIGTERM into the stop file match_lifecycle.gd polls.
COPY <<'EOF' /server/start.sh
#!/bin/sh
trap 'touch /tmp/gameye-stop' TERM INT
rm -f /tmp/gameye-stop
/server/game-server.x86_64 --headless "$@" &
child=$!
wait "$child"; rc=$?
while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done
exit "$rc"
EOF
RUN chmod +x /server/game-server.x86_64 /server/start.sh
USER game
EXPOSE 7777/udp
ENTRYPOINT ["/server/start.sh"]
