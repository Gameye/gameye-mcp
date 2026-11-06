FROM debian:bookworm-slim
WORKDIR /server
COPY build/ /server/
USER root
EXPOSE 7777/udp
ENTRYPOINT ["/server/game-server", "--port", "7777"]
