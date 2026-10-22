# One image for the API (which also serves the web app) and the collector. No npm install, no build step.
FROM node:24.21.0-alpine
WORKDIR /app
COPY api ./api
COPY collector ./collector
COPY web ./web
COPY scripts ./scripts
COPY lava.config.example.json ./lava.config.example.json
RUN mkdir -p /data && chown node:node /data
USER node
ENV LAVA_CONFIG=/app/lava.config.json LAVA_DATA=/data LAVA_PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LAVA_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/server.mjs"]
