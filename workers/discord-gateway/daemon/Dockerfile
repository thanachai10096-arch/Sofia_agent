FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY worker.mjs ./worker.mjs
USER node
CMD ["node", "worker.mjs"]
