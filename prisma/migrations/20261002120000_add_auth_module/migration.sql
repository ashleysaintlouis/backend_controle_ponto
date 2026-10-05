ALTER TABLE "users"
  ADD COLUMN "googleId" TEXT,
  ADD COLUMN "passwordResetToken" VARCHAR(255),
  ADD COLUMN "passwordResetExpiresAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "users_googleId_key"
  ON "users"("googleId");
