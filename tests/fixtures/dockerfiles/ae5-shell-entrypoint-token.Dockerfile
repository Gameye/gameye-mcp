FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 game && useradd --system --uid 10001 --gid game game
WORKDIR /server
COPY --chown=game:game build/ /server/
ENV GAMEYE_API_TOKEN=gy_fake_dockerfile_token_9f8e7d6c5b4a
USER game
EXPOSE 7777/udp
ENTRYPOINT /server/game-server --port 7777
