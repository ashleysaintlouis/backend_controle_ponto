FROM node:22-bookworm-slim

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
CMD ["npm", "start"]