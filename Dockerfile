FROM node:24-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 DATA_DIR=/data PORT=8080
WORKDIR /app
COPY server.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
