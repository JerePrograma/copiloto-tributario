import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const email = "demo@laburen.local";
  const passcode = "123456";
  await prisma.invitedUser.upsert({
    where: { email },
    create: { email, passcode },
    update: { passcode },
  });
  console.log("Seed OK:", { email, passcode });
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
