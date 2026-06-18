FROM node:26.2.0-alpine3.23

WORKDIR /app

RUN npm install -g bun

COPY package.json ./

RUN bun install

COPY . .

RUN npx prisma generate

EXPOSE 3001 3002

CMD ["sh", "-c", "npx prisma migrate deploy && bun run prod"]
