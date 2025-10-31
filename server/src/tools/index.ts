import { tool } from "ai";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { searchDocuments } from "../rag/search";

export interface ToolAuthContext {
  ensureAuthenticated: () => { userId?: string };
  setAuthenticated: (userId: string | undefined, email?: string) => void;
}

export function createToolset(ctx: ToolAuthContext) {
  return {
    verify_passcode: tool({
      description: "Valida un passcode y retorna el usuario asociado.",
      parameters: z.object({
        passcode: z.string().min(4),
      }),
      async execute({ passcode }) {
        const user = await prisma.invitedUser.findFirst({
          where: { passcode },
        });
        if (!user) {
          ctx.setAuthenticated(undefined);
          return { valid: false };
        }
        ctx.setAuthenticated(user.id, user.email);
        return {
          valid: true,
          userId: user.id,
          email: user.email,
        };
      },
    }),
    create_lead: tool({
      description: "Crea un lead comercial asociado al usuario autenticado.",
      parameters: z.object({
        name: z.string().min(2),
        company: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().min(6).max(32).optional(),
        userId: z.string().cuid().optional(),
      }),
      async execute({ name, company, email, phone, userId }) {
        const auth = ctx.ensureAuthenticated();
        const lead = await prisma.lead.create({
          data: {
            name,
            company,
            email,
            phone,
            userId: userId ?? auth.userId,
          },
        });
        return { lead };
      },
    }),
    record_note: tool({
      description: "Registra una nota para un lead existente.",
      parameters: z.object({
        leadId: z.string().cuid(),
        content: z.string().min(5),
        userId: z.string().cuid().optional(),
      }),
      async execute({ leadId, content, userId }) {
        const auth = ctx.ensureAuthenticated();
        const note = await prisma.note.create({
          data: { leadId, content, userId: userId ?? auth.userId },
        });
        return { note };
      },
    }),
    list_notes: tool({
      description: "Lista notas asociadas a un lead.",
      parameters: z.object({
        leadId: z.string().cuid(),
      }),
      async execute({ leadId }) {
        ctx.ensureAuthenticated();
        const notes = await prisma.note.findMany({
          where: { leadId },
          orderBy: { createdAt: "desc" },
        });
        return { notes };
      },
    }),
    schedule_followup: tool({
      description: "Agenda un follow-up y opcionalmente genera una nota.",
      parameters: z.object({
        leadId: z.string().cuid(),
        dueAt: z.string(),
        note: z.string().optional(),
      }),
      async execute({ leadId, dueAt, note }) {
        ctx.ensureAuthenticated();
        const followup = await prisma.followUp.create({
          data: {
            leadId,
            dueAt: new Date(dueAt),
          },
        });
        if (note) {
          await prisma.note.create({
            data: { leadId, content: note },
          });
        }
        return { followup };
      },
    }),
    list_followups: tool({
      description: "Lista follow-ups por estado.",
      parameters: z.object({
        leadId: z.string().cuid().optional(),
        status: z.enum(["PENDING", "DONE", "CANCELED"]).optional(),
      }),
      async execute({ leadId, status }) {
        ctx.ensureAuthenticated();
        const followups = await prisma.followUp.findMany({
          where: {
            leadId,
            status,
          },
          orderBy: { dueAt: "asc" },
        });
        return { followups };
      },
    }),
    complete_followup: tool({
      description: "Marca un follow-up como completado.",
      parameters: z.object({
        followupId: z.string().cuid(),
      }),
      async execute({ followupId }) {
        ctx.ensureAuthenticated();
        const followup = await prisma.followUp.update({
          where: { id: followupId },
          data: { status: "DONE", completedAt: new Date() },
        });
        return { followup };
      },
    }),
    search_docs: tool({
      description: "Busca normativa relevante y devuelve chunks con similitud.",
      parameters: z.object({
        query: z.string().min(4),
        k: z.number().int().min(1).max(12).optional(),
      }),
      async execute({ query, k }) {
        const result = await searchDocuments(query, k ?? 6, {
          rerankMode: "lexical",
        });
        return result;
      },
    }),
  } as const;
}

export type Toolset = ReturnType<typeof createToolset>;
