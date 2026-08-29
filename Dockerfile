FROM node:24.19.0-alpine

LABEL io.modelcontextprotocol.server.name="io.github.marcomoauro/substack-mcp"

COPY ./ /opt
WORKDIR /opt

RUN npm ci --omit=dev && \
    npm cache clean --force;

CMD ["node", "src/index.js"]
