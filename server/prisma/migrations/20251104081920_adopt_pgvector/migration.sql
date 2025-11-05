ALTER TABLE "InvitedUser" ADD COLUMN IF NOT EXISTS "name" TEXT;

UPDATE "InvitedUser"
SET "name" = COALESCE(NULLIF(split_part("email",'@',1), ''), CONCAT('user_', substr("id",1,8)))
WHERE "name" IS NULL;

ALTER TABLE "InvitedUser" ALTER COLUMN "name" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "InvitedUser_name_key" ON "InvitedUser"("name");
