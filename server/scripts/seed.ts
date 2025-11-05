// prisma/seed.ts
import { prisma } from "../src/lib/prisma";

async function upsertInvitedByName(
  name: string,
  passcode: string,
  email?: string
) {
  return prisma.invitedUser.upsert({
    where: { name }, // clave única ahora
    create: { name, passcode, ...(email ? { email } : {}) },
    update: { passcode, ...(email ? { email } : {}) },
    select: { id: true, name: true, email: true },
  });
}

async function ensureLeadWithNote(
  userId: string,
  leadName: string,
  email?: string
) {
  const existing = await prisma.lead.findFirst({
    where: { userId, name: leadName },
  });
  const lead =
    existing ??
    (await prisma.lead.create({
      data: { userId, name: leadName, email, status: "new" },
      select: { id: true, name: true },
    }));

  const noteCount = await prisma.note.count({ where: { leadId: lead.id } });
  if (noteCount === 0) {
    await prisma.note.create({
      data: {
        leadId: lead.id,
        userId,
        content: `Nota inicial para ${lead.name}: creada por seed`,
      },
    });
  }

  const fuCount = await prisma.followUp.count({ where: { leadId: lead.id } });
  if (fuCount === 0) {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    await prisma.followUp.create({
      data: { leadId: lead.id, dueAt: due, status: "PENDING" },
    });
  }
}

async function main() {
  const invited = await Promise.all([
    upsertInvitedByName("demo", "123456", "demo@laburen.local"),
    upsertInvitedByName("analista", "654321", "analista@laburen.local"),
    upsertInvitedByName("estudio", "LAB-2025", "estudio@laburen.local"),
    upsertInvitedByName("externo", "EXT-0001", "externo@laburen.local"),
    upsertInvitedByName("jeremias", "654321", "jeremias@prueba.local"),
  ]);

  await ensureLeadWithNote(
    invited[0].id,
    "PyME Servicios SRL",
    "contacto@pymeservicios.test"
  );
  await ensureLeadWithNote(invited[0].id, "Kiosco San Martín");
  await ensureLeadWithNote(
    invited[1].id,
    "Freelancer Diseño UX",
    "ux@freela.test"
  );

  console.log(
    "Seed OK:",
    invited.map((u) => ({ id: u.id, name: u.name, email: u.email }))
  );
}

main()
  .catch((error) => {
    console.error("Seed error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
