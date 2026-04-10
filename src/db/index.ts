import { PrismaClient } from "@prisma/client";
import type { SessionStatus } from "../types";

export const prisma = new PrismaClient();

// ─── Users ───

export async function findOrCreateUser(telegramId: bigint) {
  return prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
}

export async function updateNotifyTime(telegramId: bigint, time: string) {
  return prisma.user.update({
    where: { telegramId },
    data: { notifyTime: time },
  });
}

export async function getAllUsers() {
  return prisma.user.findMany({ include: { projects: true } });
}

// ─── Projects ───

export async function getUserProjects(telegramId: bigint) {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { projects: true },
  });
  return user?.projects ?? [];
}

export async function addProject(
  telegramId: bigint,
  projectName: string,
  spreadsheetId: string
) {
  const user = await findOrCreateUser(telegramId);
  return prisma.project.create({
    data: { userId: user.id, projectName, spreadsheetId },
  });
}

export async function getProjectById(projectId: string) {
  return prisma.project.findUnique({ where: { id: projectId } });
}

// ─── Sessions ───

export async function createSession(
  telegramId: bigint,
  projectId: string,
  momDraft: string
) {
  const user = await findOrCreateUser(telegramId);
  // Close any existing pending sessions for this user
  await prisma.session.updateMany({
    where: { userId: user.id, status: "pending_review" },
    data: { status: "approved" },
  });
  return prisma.session.create({
    data: {
      userId: user.id,
      projectId,
      momDraft,
      status: "pending_review",
    },
  });
}

export async function getActiveSession(telegramId: bigint) {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return null;
  return prisma.session.findFirst({
    where: { userId: user.id, status: "pending_review" },
    include: { project: true },
    orderBy: { id: "desc" },
  });
}

export async function updateSessionDraft(sessionId: string, draft: string) {
  return prisma.session.update({
    where: { id: sessionId },
    data: { momDraft: draft },
  });
}

export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
) {
  return prisma.session.update({
    where: { id: sessionId },
    data: { status },
  });
}
