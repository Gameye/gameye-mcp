# Source: gameye-skills v1.6.1, skills/gameye-unreal-server/SKILL.md, Container specifics (MIT License, Copyright (c) 2026 Gameye B.V.).
# Copied verbatim below this header as a golden clean case.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 game \
 && useradd --system --uid 10001 --gid game --no-create-home --shell /usr/sbin/nologin game
WORKDIR /server
COPY --chown=game:game LinuxServer/ /server/
USER game
EXPOSE 7777/udp
ENTRYPOINT ["/server/MyGameServer.sh", "-port=7777", "-log", "-stdout", \
            "-FullStdOutLogOutput", "-unattended"]
