import { prisma } from "../src/lib/prisma";

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
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
