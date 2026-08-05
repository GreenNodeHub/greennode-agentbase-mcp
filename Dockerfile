FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY registry.generated.json ./

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
