-- Cria a tabela "users" caso ela não exista
CREATE TABLE IF NOT EXISTS "users" (
    -- Defina aqui as colunas básicas da sua tabela users, por exemplo:
    "id" SERIAL PRIMARY KEY,
    "email" TEXT UNIQUE NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Adiciona as colunas caso elas ainda não existam
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetToken" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMPTZ(6);

-- Cria o índice único para o googleId caso ele ainda não exista
CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");
