FROM node:22-bookworm-slim

# Instala o OpenSSL exigido pelo Prisma
RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
RUN npm run build

EXPOSE 3333

# Executa a atualização/migração no banco do Neon e em seguida inicia o servidor
CMD ["sh", "-c", "npx prisma db update || npx prisma db migrate && npm start"]

