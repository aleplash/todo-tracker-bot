// src/services/person-resolver.ts
//
// Разовая кластеризация исполнителей через Claude + кеш.
//
// Зачем: уменьшительные ("Саша"→"Александр"), опечатки и разные транслиты
// нельзя вывести из строки. Claude один раз группирует УНИКАЛЬНЫЕ строки
// "Ответственный" (их десятки) в кластеры-людей. Результат кешируется и
// пересобирается только при изменении набора строк. Запросы → дешёвый lookup.

import { extractJsonFromClaude } from "./gemini";
import { matchesAssignee, membershipKey } from "./people";

export interface PersonCluster {
  canonical: string; // "Александр Николаев"
  variants: string[]; // сырые строки из таблиц, относящиеся к человеку
}

// ─── Кеш ───
// In-memory. Для продакшена заменить на БД: таблица person_clusters
// (workspace_id, signature text, clusters_json jsonb). Семантика та же:
// если signature совпал — отдать сохранённые кластеры, иначе пересобрать.
const cache = new Map<string, { signature: string; clusters: PersonCluster[] }>();

function signatureOf(distinct: string[]): string {
  return distinct.map((s) => s.trim().toLowerCase()).sort().join("|");
}

/**
 * Возвращает кластеры людей для набора уникальных исполнителей.
 * LLM вызывается только при изменении набора (cache-miss по signature).
 */
export async function getClusters(
  workspaceKey: string,
  distinctAssignees: string[]
): Promise<PersonCluster[]> {
  const clean = dedupe(distinctAssignees);
  if (clean.length === 0) return [];

  const sig = signatureOf(clean);
  const hit = cache.get(workspaceKey);
  if (hit && hit.signature === sig) return hit.clusters;

  let clusters: PersonCluster[];
  try {
    clusters = await clusterWithClaude(clean);
  } catch (error) {
    console.error("[resolver] clustering failed, fallback to identity:", error);
    // Фолбэк: каждая строка — отдельный человек. Матчер всё равно покроет
    // регистр/транслит/падежи; потеряем только уменьшительные.
    clusters = clean.map((v) => ({ canonical: v, variants: [v] }));
  }

  cache.set(workspaceKey, { signature: sig, clusters });
  return clusters;
}

/** Сбрасывает кеш (например, после добавления проекта). */
export function invalidateClusters(workspaceKey: string): void {
  cache.delete(workspaceKey);
}

// ─── Поиск кластера по введённому имени ───

/**
 * Находит кластеры, подходящие под запрос. Возвращает массив:
 *   []        — не найдено;
 *   [c]       — однозначно;
 *   [c1, c2]  — неоднозначно (например, два разных "Саши") → уточнить у юзера.
 */
export function findClusters(
  clusters: PersonCluster[],
  query: string
): PersonCluster[] {
  return clusters.filter(
    (c) =>
      matchesAssignee(c.canonical, query) ||
      c.variants.some((v) => matchesAssignee(v, query))
  );
}

/**
 * Карта "ключ строки таблицы → каноничное имя".
 * Строится из исходных строк, чтобы маппинг был точным даже если LLM слегка
 * переписала вариант.
 */
export function buildMembershipMap(
  clusters: PersonCluster[],
  distinctAssignees: string[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of dedupe(distinctAssignees)) {
    const key = membershipKey(raw);
    let canon = clusters.find((c) =>
      c.variants.some((v) => membershipKey(v) === key)
    )?.canonical;
    if (!canon) {
      canon = clusters.find(
        (c) =>
          matchesAssignee(c.canonical, raw) ||
          c.variants.some((v) => matchesAssignee(v, raw))
      )?.canonical;
    }
    if (canon) map.set(key, canon);
  }
  return map;
}

// ─── Внутреннее ───

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const v = (s ?? "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

async function clusterWithClaude(distinct: string[]): Promise<PersonCluster[]> {
  const prompt =
    "Тебе дан список строк из колонки \"Ответственный\" рабочих таблиц. " +
    "Сгруппируй строки, относящиеся к ОДНОМУ человеку. Учитывай:\n" +
    "- уменьшительные/полные формы (Саша=Александр, Дима=Дмитрий, Ваня=Иван, Миша=Михаил);\n" +
    "- транслитерацию (Максим=Maxim=Max), регистр, префикс @;\n" +
    "- инициалы и роли в скобках (\"Maxim D.\", \"Maxim (PM)\");\n" +
    "- падежи (\"Максима\", \"Сашу\").\n\n" +
    "ПРАВИЛА:\n" +
    "- НЕ объединяй явно разных людей. Если совпадает только имя без фамилии и " +
    "однозначно определить нельзя — оставь отдельным кластером.\n" +
    "- В variants клади строки СТРОГО как во входе, дословно.\n" +
    "- canonical — наиболее полная/формальная форма из группы.\n" +
    "- Ответ — СТРОГО JSON-массив без markdown:\n" +
    '[{"canonical":"Имя Фамилия","variants":["...","..."]}]\n\n' +
    "Входные строки:\n" +
    distinct.map((s) => `- ${s}`).join("\n");

  const result = await extractJsonFromClaude<PersonCluster[]>(prompt);
  if (!Array.isArray(result)) return [];
  return result.filter(
    (c) => c && typeof c.canonical === "string" && Array.isArray(c.variants)
  );
}

