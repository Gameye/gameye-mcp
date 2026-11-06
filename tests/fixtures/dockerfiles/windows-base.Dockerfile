FROM mcr.microsoft.com/windows/servercore:ltsc2022
WORKDIR C:/server
COPY build/ C:/server/
USER ContainerUser
EXPOSE 7777/udp
ENTRYPOINT ["C:/server/GameServer.exe", "-port=7777"]
