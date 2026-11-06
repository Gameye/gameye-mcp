FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
USER node
EXPOSE 8080/tcp
CMD ["npm", "start"]
