// src/services/people.ts
//
// Строковые утилиты для сопоставления имён исполнителей.
//
// ВАЖНО: этот модуль НЕ пытается в одиночку угадать "Саша = Александр" —
// уменьшительные и опечатки не выводятся из строки. За объединение вариантов
// одного человека отвечает person-resolver.ts (разовая LLM-кластеризация +
// кеш). Здесь — только нормализация, транслитерация и матчер с допуском на
// падежные окончания, который используется для:
//   1) сопоставления введённого запроса с вариантами уже собранного кластера;
//   2) маппинга строки таблицы на кластер.

// ─── (опционально) ручные override-алиасы ───
// По умолчанию ПУСТО — реестр вести не нужно. Можно точечно дополнить
// крайние случаи, которые LLM путает (например, чистая роль "Maxim (PM)").
const MANUAL_ALIASES: Record<string, string[]> = {
  // "Maxim Dubinin": ["Maxim (PM)"],
};

// ─── Транслитерация ───

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function translit(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) out += CYRILLIC_TO_LATIN[ch] ?? ch;
  return out;
}

function canonToken(t: string): string {
  let x = translit(t.toLowerCase());
  x = x.replace(/[^a-z]/g, "");
  x = x.replace(/ks/g, "x"); // "maksim" ≈ "maxim"
  x = x.replace(/kh/g, "h"); // "Mikhail" ≈ "Михаил"
  return x;
}

function tokenize(raw: string): string[] {
  const cleaned = raw.replace(/\(.*?\)/g, " ").replace(/@/g, " ");
  return cleaned
    .split(/[\s,;/]+/)
    .map(canonToken)
    .filter((t) => t.length > 0);
}

// ─── Ручные алиасы (если заданы) ───

function aliasCanonicalsFor(raw: string): string[] {
  const norm = raw.trim().toLowerCase();
  const out: string[] = [];
  for (const [canon, aliases] of Object.entries(MANUAL_ALIASES)) {
    if (canon.toLowerCase() === norm || aliases.some((a) => a.toLowerCase() === norm)) {
      out.push(canon);
    }
  }
  return out;
}

function tokenSets(raw: string): string[][] {
  const sets = [tokenize(raw)];
  for (const canon of aliasCanonicalsFor(raw)) sets.push(tokenize(canon));
  return sets.filter((s) => s.length > 0);
}

// ─── Сравнение токенов с допуском на падежи ───

function commonPrefix(a: string, b: string): number {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function tokenMatch(q: string, a: string): boolean {
  if (q.length === 1) return a.startsWith(q); // инициал в запросе
  if (a.length === 1) return q.startsWith(a); // инициал в таблице
  if (a.startsWith(q) || q.startsWith(a)) return true; // префикс (max→maxim)
  // Допуск на падежное окончание: "саша" vs "сашу", "иванова" vs "иванову".
  const cp = commonPrefix(q, a);
  const shorter = Math.min(q.length, a.length);
  return cp >= 3 && cp >= shorter - 1;
}

/**
 * Совпадает ли строка-исполнитель с введённым именем.
 * Каждый токен запроса должен найти пару среди токенов исполнителя.
 */
export function matchesAssignee(assignee: string, query: string): boolean {
  const qSets = tokenSets(query);
  const aSets = tokenSets(assignee);
  if (qSets.length === 0 || aSets.length === 0) return false;

  for (const q of qSets) {
    for (const a of aSets) {
      if (q.every((qt) => a.some((at) => tokenMatch(qt, at)))) return true;
    }
  }
  return false;
}

/**
 * Ключ для точного сопоставления "строка таблицы → кластер".
 * Канонизирует и сортирует токены, чтобы порядок имя/фамилия не мешал.
 */
export function membershipKey(raw: string): string {
  return tokenize(raw).slice().sort().join(" ");
}

