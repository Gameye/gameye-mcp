FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 game && useradd --system --uid 10001 --gid game game
WORKDIR /server
COPY --chown=game:game build/ /server/
USER game
EXPOSE 7777/udp
ENTRYPOINT ["/server/game-server", "--bind=127.0.0.1", "--port", "7777"]
