FROM node:24-alpine
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/server/main.ts"]
