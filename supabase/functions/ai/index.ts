// Edge Function «ai»: распознаёт КБЖУ по фото этикетки и ищет КБЖУ блюда в интернете.
// Ключ Anthropic хранится в секрете ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets)
// и в браузер не попадает. Промпты перенесены из бота (bot/ai.py).

const MODEL = Deno.env.get("AI_MODEL") ?? "claude-haiku-4-5";
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LABEL_PROMPT = `Ты помогаешь распознать пищевую ценность продукта по фото упаковки/этикетки. Этикетка может быть на русском, сербском или английском (сербские слова: «Energetska vrednost», «ugljeni hidrati» — углеводы, «masti» — жиры, «belančevine»/«proteini» — белки).
Найди таблицу «Пищевая ценность» / «Nutritivna vrednost» и название продукта. Фото может быть несколько (лицевая сторона и таблица) — используй все вместе; если цифры расходятся, бери более чёткую и упомяни это в note.
Калорийность: бери kcal/ккал. Если есть только kJ — раздели на 4.184 и скажи об этом в note.
Приведи всё к расчёту НА 100 Г (если на этикетке на порцию или на 100 мл — пересчитай и скажи в note).
Ответь СТРОГО JSON без слов до и после:
{"name": "название продукта", "kcal": число, "p": число, "f": число, "c": число, "confidence": "high|medium|low", "note": "кратко по-русски, что пересчитано или предположено, иначе пустая строка"}
Если данных не видно — confidence "low" и объясни в note.`;

const SEARCH_PROMPT = (q: string) => `Найди в интернете пищевую ценность (калорийность, белки, жиры, углеводы) для еды: «${q}». Это может быть блюдо сети ресторанов/фастфуда (бери данные производителя) или обычная домашняя еда (бери усреднённые данные из нескольких источников).
Если оценки по источникам расходятся больше чем на 20–25%, верни до 3 вариантов с коротким пояснением в label (например «домашние, с рисом и мясом», «Lidl», «в кафе»). Если сходятся — один вариант. Для каждого оцени реалистичный вес одной порции в граммах.
Значения kcal/p/f/c — НА 100 Г.
В конце ответь СТРОГО JSON без слов до и после:
{"candidates": [{"label": "пояснение по-русски", "portion_g": число, "kcal": число, "p": число, "f": число, "c": число, "source_url": "ссылка или пустая строка", "confidence": "high|medium|low"}]}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function extractJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Не удалось разобрать ответ модели");
  return JSON.parse(m[0]);
}

async function claude(body: Record<string, unknown>) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `Anthropic API ${r.status}`);
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return extractJson(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!KEY) return json({ error: "Не задан секрет ANTHROPIC_API_KEY в Supabase" }, 500);
  try {
    const body = await req.json();
    if (body.action === "label") {
      const images = (body.images ?? []).slice(0, 4);
      if (!images.length) return json({ error: "Нет фото" }, 400);
      const content = images.map((im: { data: string; type?: string }) => ({
        type: "image", source: { type: "base64", media_type: im.type ?? "image/jpeg", data: im.data },
      }));
      content.push({ type: "text", text: LABEL_PROMPT });
      return json(await claude({ max_tokens: 800, messages: [{ role: "user", content }] }));
    }
    if (body.action === "search") {
      const q = String(body.query ?? "").slice(0, 200).trim();
      if (!q) return json({ error: "Пустой запрос" }, 400);
      return json(await claude({
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: SEARCH_PROMPT(q) }],
      }));
    }
    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
