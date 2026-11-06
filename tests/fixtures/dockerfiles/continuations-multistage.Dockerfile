# Build stage runs as root on purpose; only the final stage is the runtime image.
FROM debian:bookworm-slim AS build
RUN apt-get update \
 # a comment inside a continuation is dropped by Docker
 && apt-get install -y --no-install-recommends build-essential \

 && rm -rf /var/lib/apt/lists/*
RUN <<EOT
echo "heredoc body lines are not instructions"
USER root
EXPOSE 1234/tcp
ENTRYPOINT npm start
EOT
USER root
CMD make server

FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 game \
 && useradd --system --uid 10001 --gid game game
WORKDIR /server
COPY --from=build --chown=game:game /out/ /server/
USER game
EXPOSE 7777/udp \
       7778/udp
ENTRYPOINT ["/server/game-server", \
            "--port", "7777", \
            "--query-port", "7778"]
