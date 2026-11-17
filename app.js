"use strict";
/* Еда — рецепты, меню недели, покупки, дневник. Данные в Supabase (если настроен), иначе в браузере. */
const CFG = window.EDA_CONFIG || {};
const PEOPLE = [{ id: "liza", name: "Лиза" }, { id: "oleg", name: "Олег" }];
const MEALS = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };
const RMEALS = { breakfast: "Завтраки", lunch: "Обеды", dinner: "Ужины", other: "Другое" };
const CATS = ["Овощи и фрукты", "Мясо и рыба", "Молочные продукты", "Яйца", "Крупы и бакалея", "Консервы и соусы", "Заморозка", "Прочее"];
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = p => p + "-" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const n = v => { if (v === null || v === undefined || v === "") return null; const x = Number(String(v).replace(",", ".")); return isFinite(x) ? x : null; };
const r0 = v => v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("ru-RU");
const r1 = v => v == null || !isFinite(v) ? "—" : (Math.round(v * 10) / 10).toLocaleString("ru-RU");
const r2 = v => v == null || !isFinite(v) ? "—" : (Math.round(v * 100) / 100).toLocaleString("ru-RU");
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const norm = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/* ---------- хранение ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem("eda:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("eda:" + k, JSON.stringify(v)); } catch { } },
};
const SB = CFG.supabaseUrl && CFG.supabaseKey ? {
  base: CFG.supabaseUrl.replace(/\/$/, ""),
  h(extra) { const h = { apikey: CFG.supabaseKey, "Content-Type": "application/json", ...(extra || {}) }; if (!/^sb_/.test(CFG.supabaseKey)) h.Authorization = "Bearer " + CFG.supabaseKey; return h; },
  async req(path, opt = {}) {
    const r = await fetch(this.base + "/rest/v1/" + path, { ...opt, headers: this.h(opt.headers) });
    if (!r.ok) throw new Error((await r.text()) || r.status);
    return r.status === 204 || opt.method === "DELETE" ? null : r.json().catch(() => null);
  },
  all(t, q = "") { return this.req(`${t}?select=*${q}`); },
  upsert(t, rows) { return this.req(`${t}?on_conflict=${t === "kv" ? "key" : "id"}`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }); },
  del(t, id) { return this.req(`${t}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }); },
} : null;

const S = { products: {}, recipes: {}, plan: null, goals: {}, body: {}, diary: {}, person: LS.get("person", "liza"), tab: LS.get("tab", "diary"), day: today(), openRecipe: null, online: !!SB };

function cacheSave() { LS.set("cache", { products: S.products, recipes: S.recipes, plan: S.plan, goals: S.goals, body: S.body }); }
async function save(table, row) {
  row.updated = new Date().toISOString();
  if (table === "products") S.products[row.id] = row;
  if (table === "recipes") S.recipes[row.id] = row;
  cacheSave(); refreshNames();
  if (SB) { try { await SB.upsert(table, [row]); } catch (e) { toast("Не сохранилось на сервере: " + e.message); queue(table, row); } }
}
async function remove(table, id) {
  if (table === "products") delete S.products[id];
  if (table === "recipes") delete S.recipes[id];
  cacheSave(); refreshNames();
  if (SB) { try { await SB.del(table, id); } catch (e) { toast("Не удалилось на сервере: " + e.message); } }
}
async function saveKV(key, value) {
  if (key === "plan") S.plan = value; if (key === "goals") S.goals = value; if (key === "body") S.body = value;
  cacheSave();
  if (SB) { try { await SB.upsert("kv", [{ key, value, updated: new Date().toISOString() }]); } catch (e) { queue("kv", { key, value }); } }
}
function queue(table, row) { const q = LS.get("queue", []); q.push({ table, row }); LS.set("queue", q); }
async function flushQueue() {
  if (!SB) return; const q = LS.get("queue", []); if (!q.length) return;
  const rest = [];
  for (const it of q) { try { await SB.upsert(it.table, [it.row]); } catch { rest.push(it); } }
  LS.set("queue", rest);
}

async function load() {
  const c = LS.get("cache", null);
  if (c) Object.assign(S, { products: c.products || {}, recipes: c.recipes || {}, plan: c.plan, goals: c.goals || {}, body: c.body || {} });
  if (SB) {
    try {
      await flushQueue();
      const [p, r, kv] = await Promise.all([SB.all("products"), SB.all("recipes"), SB.all("kv")]);
      S.products = Object.fromEntries(p.map(x => [x.id, x]));
      S.recipes = Object.fromEntries(r.map(x => [x.id, x]));
      for (const row of kv) { if (row.key === "plan") S.plan = row.value; if (row.key === "goals") S.goals = row.value; if (row.key === "body") S.body = row.value; }
      S.online = true; cacheSave();
    } catch (e) { S.online = false; status("нет связи, показываю сохранённое"); }
  }
  if (!Object.keys(S.recipes).length) {
    // Первый запуск: перенос данных из Google-таблицы (data/seed.json)
    try {
      const seed = await fetch("data/seed.json").then(r => r.json());
      for (const p of seed.products) S.products[p.id] = p;
      for (const r of seed.recipes) S.recipes[r.id] = r;
      cacheSave();
      if (SB) { await SB.upsert("products", seed.products); await SB.upsert("recipes", seed.recipes); toast("Перенесла рецепты и продукты из таблицы"); }
    } catch (e) { console.warn(e); }
  }
  if (!S.plan) S.plan = { items: [], extras: [], checked: {}, home: {} };
  refreshNames();
}

async function loadDiary(person, day) {
  const key = person + "|" + day;
  const local = LS.get("diary:" + key, null);
  if (local) S.diary[key] = local;
  if (SB) {
    try { const rows = await SB.all("diary", `&person=eq.${person}&day=eq.${day}&order=created.asc`); S.diary[key] = rows; LS.set("diary:" + key, rows); }
    catch { }
  }
  return S.diary[key] || [];
}
async function addDiary(entry) {
  const key = entry.person + "|" + entry.day;
  entry.id = entry.id || uid("d"); entry.created = entry.created || new Date().toISOString();
  (S.diary[key] = S.diary[key] || []).push(entry);
  LS.set("diary:" + key, S.diary[key]);
  if (SB) { try { await SB.upsert("diary", [entry]); } catch (e) { queue("diary", entry); toast("Сохранено на телефоне, отправлю позже"); } }
}
async function delDiary(entry) {
  const key = entry.person + "|" + entry.day;
  S.diary[key] = (S.diary[key] || []).filter(x => x.id !== entry.id);
  LS.set("diary:" + key, S.diary[key]);
  if (SB) { try { await SB.del("diary", entry.id); } catch { } }
}

/* ---------- расчёты, как в Google-таблице ---------- */
function productByName(name) { const k = norm(name); return Object.values(S.products).find(p => norm(p.name) === k); }
function itemProduct(it) { return (it.pid && S.products[it.pid]) || productByName(it.name); }

// КБЖУ продукта на 100 г. Если продукт «из рецепта» — берём «в 100 г.» того рецепта.
function per100OfProduct(p, depth = 0) {
  if (!p) return null;
  if (p.recipe_id && S.recipes[p.recipe_id] && depth < 5) {
    const c = calcRecipe(S.recipes[p.recipe_id], depth + 1);
    return c.per100 ? { ...c.per100, fromRecipe: true } : null;
  }
  if ([p.kcal, p.p, p.f, p.c].some(v => v == null || !isFinite(Number(v)))) return null;
  return { kcal: +p.kcal, p: +p.p, f: +p.f, c: +p.c };
}
const KEYS = ["kcal", "p", "f", "c"];
function mul(o, k) { return o ? { kcal: o.kcal * k, p: o.p * k, f: o.f * k, c: o.c * k } : null; }

function calcRecipe(r, depth = 0) {
  const rows = (r.items || []).map(it => {
    const prod = itemProduct(it);
    const g = n(it.g) || 0;
    const per100 = per100OfProduct(prod, depth);
    let err = null;
    if (!prod) err = "нет в базе продуктов";
    else if (!per100) err = prod.recipe_id ? "не посчитан рецепт-основа" : "нет КБЖУ";
    return { it, prod, g, per100, dish: per100 ? mul(per100, g / 100) : null, err };
  });
  const total = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const row of rows) if (row.dish) for (const k of KEYS) total[k] += row.dish[k];
  const raw = rows.reduce((s, x) => s + x.g, 0);
  const errors = rows.filter(x => x.err && x.g > 0);
  const pcs = r.unit === "pcs";
  const cooked = n(r.cooked);
  const yieldW = pcs ? cooked : (cooked || raw);
  const per100 = !pcs && yieldW ? mul(total, 100 / yieldW) : null;
  const perPiece = pcs && cooked ? mul(total, 1 / cooked) : null;
  const portions = {};
  for (const pr of PEOPLE) {
    const amt = n(r.portions?.[pr.id]);
    if (amt) portions[pr.id] = { amt, v: pcs ? mul(perPiece, amt) : mul(per100, amt / 100) };
  }
  return { rows, total, raw, cooked, yieldW, noCooked: !pcs && !cooked, per100, perPiece, portions, errors, pcs };
}
// Сколько КБЖУ в количестве amount (г или шт) рецепта
function recipeAmount(r, amount) { const c = calcRecipe(r); return c.pcs ? mul(c.perPiece, amount) : mul(c.per100, amount / 100); }

// Ингредиенты для покупок: блюда-основы (рис отварной и т.п.) раскладываются на сырые продукты
function rawIngredients(r, factor, out, depth = 0) {
  for (const it of r.items || []) {
    const g = (n(it.g) || 0) * factor; if (!g) continue;
    const p = itemProduct(it);
    if (p && p.recipe_id && S.recipes[p.recipe_id] && depth < 5) {
      const base = S.recipes[p.recipe_id]; const c = calcRecipe(base);
      if (c.yieldW) { rawIngredients(base, g / c.yieldW, out, depth + 1); continue; }
    }
    const key = p ? p.id : "name:" + it.name;
    const o = out[key] || (out[key] = { key, name: p ? p.name : it.name, cat: p?.cat || "Прочее", g: 0, from: new Set() });
    o.g += g; o.from.add(r.title);
  }
  return out;
}

/* ---------- интерфейс: общее ---------- */
function status(t) { $("#status").textContent = t || ""; }
let toastT; function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 2600); }
function refreshNames() { $("#productNames").innerHTML = Object.values(S.products).sort((a, b) => a.name.localeCompare(b.name, "ru")).map(p => `<option value="${esc(p.name)}">`).join(""); }
function kbju(v, opt = {}) {
  if (!v) return `<span class="muted small">нет данных</span>`;
  return `<div class="kbju"><span class="k"><b>${r0(v.kcal)}</b> ккал</span><span class="b">Б ${r1(v.p)}</span><span class="j">Ж ${r1(v.f)}</span><span class="u">У ${r1(v.c)}</span>${opt.suffix || ""}</div>`;
}
const TABS = [["diary", "📒", "Дневник"], ["week", "🗓️", "Неделя"], ["shop", "🛒", "Покупки"], ["recipes", "🍳", "Рецепты"], ["products", "🥕", "Продукты"]];
function renderChrome() {
  $("#tabs").innerHTML = TABS.map(([id, ic, t]) => `<button role="tab" aria-selected="${S.tab === id}" data-tab="${id}"><span class="ic">${ic}</span>${t}</button>`).join("");
  $("#who").innerHTML = PEOPLE.map(p => `<button aria-pressed="${S.person === p.id}" data-person="${p.id}">${p.name}</button>`).join("");
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-tab]"); if (t) { S.tab = t.dataset.tab; S.openRecipe = null; LS.set("tab", S.tab); render(); scrollTo(0, 0); }
  const p = e.target.closest("[data-person]"); if (p) { S.person = p.dataset.person; LS.set("person", S.person); render(); }
});
function render() {
  renderChrome();
  const v = $("#view");
  ({ diary: viewDiary, week: viewWeek, shop: viewShop, recipes: viewRecipes, products: viewProducts })[S.tab](v);
}
function openDialog(html, onMount) {
  const d = $("#dlg"); d.innerHTML = html; d.showModal();
  d.querySelectorAll("[data-close]").forEach(b => b.onclick = () => d.close());
  onMount && onMount(d); return d;
}
const pname = id => PEOPLE.find(p => p.id === id)?.name;

/* ---------- Дневник ---------- */
async function viewDiary(v) {
  const person = S.person, day = S.day;
  const goal = S.goals?.[person];
  v.innerHTML = `<div class="card"><div class="row"><button class="btn ghost" id="dPrev" aria-label="Предыдущий день">‹</button>
    <input type="date" id="dDay" value="${day}"><button class="btn ghost" id="dNext" aria-label="Следующий день">›</button>
    <span class="grow"></span><button class="btn ghost small" id="dGoal">Цели</button></div><div id="dSum" style="margin-top:12px"></div>
    <div class="row" style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
      <label class="small muted row">Вес <input type="number" step="0.1" inputmode="decimal" id="bKg" style="width:80px" value="${S.body?.[person]?.[day]?.kg ?? ""}"> кг</label>
      <input id="bAct" class="grow" placeholder="Активность: прогулка 40 мин, бассейн…" value="${esc(S.body?.[person]?.[day]?.act ?? "")}">
    </div><div class="small muted" id="bLast"></div></div>
    <div id="dMeals" style="display:flex;flex-direction:column;gap:12px"></div>`;
  const shift = d => { const x = new Date(S.day); x.setDate(x.getDate() + d); S.day = x.toISOString().slice(0, 10); render(); };
  $("#dPrev").onclick = () => shift(-1); $("#dNext").onclick = () => shift(1);
  $("#dDay").onchange = e => { S.day = e.target.value || today(); render(); };
  $("#dGoal").onclick = editGoals;
  const saveBody = () => {
    const b = JSON.parse(JSON.stringify(S.body || {})); const p = (b[person] = b[person] || {});
    const kg = n($("#bKg").value), act = $("#bAct").value.trim();
    if (kg == null && !act) delete p[day]; else p[day] = { ...(kg != null ? { kg } : {}), ...(act ? { act } : {}) };
    saveKV("body", b); toast("Сохранено");
  };
  $("#bKg").onchange = saveBody; $("#bAct").onchange = saveBody;
  const hist = Object.entries(S.body?.[person] || {}).filter(([d, x]) => x.kg != null && d < day).sort().slice(-1)[0];
  if (hist) $("#bLast").textContent = `Последнее взвешивание: ${hist[1].kg} кг (${hist[0].split("-").reverse().join(".")})`;
  const entries = await loadDiary(person, day);
  if (S.tab !== "diary" || S.person !== person || S.day !== day) return;
  const tot = { kcal: 0, p: 0, f: 0, c: 0 }; for (const e of entries) for (const k of KEYS) tot[k] += +e[k] || 0;
  const cell = (k, t, cls) => {
    const g = goal?.[k]; const pct = g ? Math.min(100, tot[k] / g * 100) : 0;
    return `<div class="goal"><div class="t">${t}</div><div class="v ${cls}">${k === "kcal" ? r0(tot[k]) : r1(tot[k])}${g ? ` <span class="muted small">/ ${r0(g)}</span>` : ""}</div>
      ${g ? `<div class="bar ${tot[k] > g * 1.05 ? "over" : ""}"><i style="width:${pct}%"></i></div><div class="t">${tot[k] <= g ? "осталось " + r0(g - tot[k]) : "больше на " + r0(tot[k] - g)}</div>` : ""}</div>`;
  };
  $("#dSum").innerHTML = `<div class="goals">${cell("kcal", "Калории", "k")}${cell("p", "Белки, г", "b")}${cell("f", "Жиры, г", "j")}${cell("c", "Углеводы, г", "u")}</div>
    ${goal ? "" : `<div class="small muted" style="margin-top:8px">Цели не заданы — нажмите «Цели».</div>`}`;
  $("#dMeals").innerHTML = Object.entries(MEALS).map(([m, t]) => {
    const list = entries.filter(e => e.meal === m);
    const s = { kcal: 0 }; list.forEach(e => s.kcal += +e.kcal || 0);
    return `<div class="card"><div class="row"><h2 class="grow">${t}</h2><span class="muted small num">${list.length ? r0(s.kcal) + " ккал" : ""}</span>
      <button class="btn primary" data-add="${m}">+ Добавить</button></div>
      <div class="list" style="margin-top:6px">${list.map(e => `<div class="li"><div class="grow"><div class="t">${esc(e.title)}</div>
        <div class="s num">${r0(e.amount)} ${e.unit === "pcs" ? "шт" : "г"} · ${r0(e.kcal)} ккал · Б ${r1(e.p)} Ж ${r1(e.f)} У ${r1(e.c)} ${srcTag(e.src)}</div></div>
        <button class="btn ghost" data-del="${e.id}" aria-label="Удалить">✕</button></div>`).join("") || `<div class="empty">Пока пусто</div>`}</div></div>`;
  }).join("") + `<button class="btn" id="dCopy">Скопировать записи из вчерашнего дня</button>`;
  v.querySelectorAll("[data-add]").forEach(b => b.onclick = () => addEntryDialog(b.dataset.add));
  v.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { const e = entries.find(x => x.id === b.dataset.del); await delDiary(e); render(); });
  $("#dCopy").onclick = async () => {
    const y = new Date(day); y.setDate(y.getDate() - 1); const yd = y.toISOString().slice(0, 10);
    const prev = await loadDiary(person, yd);
    if (!prev.length) return toast("Вчера записей нет");
    for (const e of prev) await addDiary({ ...e, id: undefined, created: undefined, day });
    toast("Скопировано: " + prev.length); render();
  };
}
function srcTag(s) { const m = { recipe: "рецепт", product: "продукт", label: "этикетка", ai: "ИИ-оценка", off: "Open Food Facts", manual: "вручную" }; return s ? `<span class="tag ${s === "ai" ? "warn" : ""}">${m[s] || s}</span>` : ""; }

function editGoals() {
  const g = S.goals || {};
  openDialog(`<div class="dh"><h2>Цели на день</h2><button class="btn ghost" data-close>✕</button></div><div class="db">
    ${PEOPLE.map(p => `<div><h3>${p.name}</h3><div class="grid4" style="margin-top:6px">
      ${[["kcal", "Ккал"], ["p", "Белки"], ["f", "Жиры"], ["c", "Углеводы"]].map(([k, t]) => `<label class="f">${t}<input type="number" inputmode="decimal" data-g="${p.id}.${k}" value="${g[p.id]?.[k] ?? ""}"></label>`).join("")}
    </div></div>`).join("")}</div><div class="df"><button class="btn primary" id="gSave">Сохранить</button></div>`, d => {
    $("#gSave", d).onclick = async () => {
      const out = {}; d.querySelectorAll("[data-g]").forEach(i => { const [p, k] = i.dataset.g.split("."); const v = n(i.value); if (v != null) (out[p] = out[p] || {})[k] = v; });
      await saveKV("goals", out); d.close(); render();
    };
  });
}

// Поиск по рецептам и продуктам
function searchAll(q) {
  const k = norm(q); if (!k) return [];
  const words = k.split(" ");
  const hit = s => { const t = norm(s); return words.every(w => t.includes(w)); };
  const rs = Object.values(S.recipes).filter(r => hit(r.title)).map(r => ({ type: "recipe", r }));
  const ps = Object.values(S.products).filter(p => hit(p.name)).map(p => ({ type: "product", p }));
  return [...rs, ...ps].slice(0, 40);
}
function planRecipes() { return (S.plan?.items || []).map(i => S.recipes[i.rid]).filter(Boolean); }

function addEntryDialog(meal) {
  const person = S.person;
  const quick = planRecipes().filter((r, i, a) => a.indexOf(r) === i);
  const d = openDialog(`<div class="dh"><h2>${MEALS[meal]} · ${pname(person)}</h2><button class="btn ghost" data-close>✕</button></div>
    <div class="db" id="aBody">
      ${quick.length ? `<div><h3>Из меню недели</h3><div class="chips" style="margin-top:6px">${quick.map(r => `<button class="chip" data-q="${r.id}">${esc(r.title)}</button>`).join("")}</div></div>` : ""}
      <input type="search" id="aQ" placeholder="Поиск: блюдо или продукт" autocomplete="off">
      <div class="res" id="aRes"></div>
      <div class="row" id="aMore">
        <button class="btn" id="aPhoto">📷 Фото этикетки</button>
        <button class="btn" id="aManual">✍️ Вручную</button>
      </div>
      <input type="file" id="aFile" accept="image/*" capture="environment" multiple hidden>
    </div>`, d => {
    const q = $("#aQ", d), res = $("#aRes", d);
    q.focus();
    const draw = () => {
      const list = searchAll(q.value);
      res.innerHTML = list.map((x, i) => x.type === "recipe"
        ? `<button data-i="${i}"><span>🍳 ${esc(x.r.title)}</span><span class="muted small">${RMEALS[x.r.meal] || ""}</span></button>`
        : `<button data-i="${i}"><span>🥕 ${esc(x.p.name)}</span><span class="muted small num">${per100OfProduct(x.p) ? r0(per100OfProduct(x.p).kcal) + " ккал/100 г" : ""}</span></button>`).join("")
        + (q.value.trim().length > 1 ? `<button data-web="1"><span>🔎 Найти «${esc(q.value.trim())}» в интернете (ИИ)</span><span class="muted small">≈10–20 с</span></button>
           <button data-off="1"><span>🏷️ Искать среди магазинных продуктов (Open Food Facts)</span></button>` : "");
      res.querySelectorAll("[data-i]").forEach(b => b.onclick = () => { const x = list[+b.dataset.i]; x.type === "recipe" ? amountStep(d, meal, { recipe: x.r }) : amountStep(d, meal, { product: x.p }); });
      const w = res.querySelector("[data-web]"); if (w) w.onclick = () => webSearch(d, meal, q.value.trim());
      const o = res.querySelector("[data-off]"); if (o) o.onclick = () => offSearch(d, meal, q.value.trim());
    };
    q.oninput = draw;
    d.querySelectorAll("[data-q]").forEach(b => b.onclick = () => amountStep(d, meal, { recipe: S.recipes[b.dataset.q] }));
    $("#aManual", d).onclick = () => amountStep(d, meal, { manual: { name: q.value.trim(), kcal: "", p: "", f: "", c: "" } });
    $("#aPhoto", d).onclick = () => $("#aFile", d).click();
    $("#aFile", d).onchange = e => labelPhoto(d, meal, [...e.target.files]);
  });
}

// Шаг 2: количество. src: {recipe} | {product} | {manual: {name,kcal,p,f,c, src, note}}
function amountStep(d, meal, src) {
  const person = S.person;
  let title, unit = "g", per = null, defAmt = 100, note = "", isNew = false;
  if (src.recipe) {
    const r = src.recipe, c = calcRecipe(r); title = r.title; unit = c.pcs ? "pcs" : "g";
    per = c.pcs ? c.perPiece : c.per100; defAmt = n(r.portions?.[person]) || (c.pcs ? 1 : 250);
    if (c.errors.length) note = `В рецепте не посчитано: ${c.errors.map(x => esc(x.it.name)).join(", ")}. Цифры занижены.`;
    if (c.noCooked) note += (note ? " " : "") + "Вес готового блюда не указан — считаю по сумме сырых продуктов.";
  } else if (src.product) { title = src.product.name; per = per100OfProduct(src.product); }
  else { const m = src.manual; title = m.name; per = m.kcal !== "" ? { kcal: n(m.kcal), p: n(m.p) || 0, f: n(m.f) || 0, c: n(m.c) || 0 } : null; defAmt = m.portion_g || 100; note = m.note || ""; isNew = true; }
  const body = $(".db", d);
  body.innerHTML = `<div><b>${esc(title || "Новая запись")}</b> ${src.recipe ? srcTag("recipe") : src.product ? srcTag("product") : srcTag(src.manual.src || "manual")}</div>
    ${note ? `<div class="notice">${note}</div>` : ""}
    ${isNew ? `<label class="f">Название<input id="mName" value="${esc(title)}"></label>
      <div class="small muted">КБЖУ на 100 г:</div>
      <div class="grid4">${KEYS.map((k, i) => `<label class="f">${["Ккал", "Белки", "Жиры", "Углеводы"][i]}<input type="number" inputmode="decimal" data-m="${k}" value="${per?.[k] ?? ""}"></label>`).join("")}</div>` :
      `<div class="small muted">${unit === "pcs" ? "На 1 шт:" : "На 100 г:"}</div>${kbju(per)}`}
    <label class="f">${unit === "pcs" ? "Сколько штук" : "Сколько грамм"}<input type="number" inputmode="decimal" id="mAmt" value="${defAmt}"></label>
    <div id="mRes"></div>
    ${isNew ? `<label class="row small"><input type="checkbox" id="mToDb" ${src.manual.src === "label" ? "checked" : ""}> Добавить в базу продуктов</label>` : ""}
    <div class="row"><button class="btn primary" id="mSave">Записать</button><button class="btn ghost" id="mBack">Назад</button></div>`;
  const cur = () => {
    let p = per;
    if (isNew) { const g = k => n(body.querySelector(`[data-m="${k}"]`).value); p = g("kcal") == null ? null : { kcal: g("kcal"), p: g("p") || 0, f: g("f") || 0, c: g("c") || 0 }; }
    const a = n($("#mAmt", body).value) || 0;
    return { p, a, v: p ? mul(p, unit === "pcs" ? a : a / 100) : null };
  };
  const upd = () => { $("#mRes", body).innerHTML = `<div class="small muted">Итого:</div>${kbju(cur().v)}`; };
  body.querySelectorAll("input").forEach(i => i.oninput = upd); upd();
  $("#mBack", body).onclick = () => { d.close(); addEntryDialog(meal); };
  $("#mSave", body).onclick = async () => {
    const { p, a, v } = cur();
    if (!v || !a) return toast("Нужны КБЖУ и количество");
    const name = isNew ? ($("#mName", body).value.trim() || "Без названия") : title;
    let ref = src.recipe?.id || src.product?.id || null;
    if (isNew && $("#mToDb", body)?.checked) {
      const prod = { id: uid("p"), name, ...p, cat: "Прочее", source: { label: "этикетка", ai: "ИИ", off: "Open Food Facts" }[src.manual.src] || "вручную", recipe_id: null };
      await save("products", prod); ref = prod.id;
    }
    await addDiary({ person, day: S.day, meal, title: name, amount: a, unit, ...v, src: src.recipe ? "recipe" : src.product ? "product" : (src.manual.src || "manual"), ref });
    d.close(); toast("Записано"); render();
  };
}

async function callAI(payload) {
  if (!SB) throw new Error("ИИ работает только с подключённым Supabase");
  const r = await fetch(SB.base + "/functions/v1/ai", { method: "POST", headers: SB.h(), body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || "Ошибка " + r.status);
  return data;
}
function shrink(file, max = 1400) {
  return new Promise((res, rej) => {
    const img = new Image(); img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = img.width * k; c.height = img.height * k;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", .85).split(",")[1]); URL.revokeObjectURL(img.src);
    }; img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}
async function labelPhoto(d, meal, files) {
  if (!files.length) return;
  const body = $(".db", d); body.innerHTML = `<div class="empty">Читаю этикетку… (5–15 секунд)</div>`;
  try {
    const images = await Promise.all(files.slice(0, 4).map(async f => ({ data: await shrink(f), type: "image/jpeg" })));
    const x = await callAI({ action: "label", images });
    amountStep(d, meal, { manual: { name: x.name || "", kcal: x.kcal ?? "", p: x.p ?? "", f: x.f ?? "", c: x.c ?? "", src: "label", note: [x.confidence === "low" ? "Распознано неуверенно — проверьте цифры по этикетке." : "", esc(x.note || "")].filter(Boolean).join(" ") } });
  } catch (e) { body.innerHTML = `<div class="notice">Не получилось: ${esc(e.message)}</div><button class="btn" onclick="this.closest('dialog').close()">Закрыть</button>`; }
}
async function webSearch(d, meal, q) {
  const body = $(".db", d); body.innerHTML = `<div class="empty">Ищу «${esc(q)}» в интернете… (10–25 секунд)</div>`;
  try {
    const x = await callAI({ action: "search", query: q });
    const list = x.candidates || [];
    body.innerHTML = `<div class="small muted">Варианты — это оценка ИИ по источникам в интернете, не точный расчёт. Выберите самый похожий:</div>
      <div class="list">${list.map((c, i) => `<div class="li"><div class="grow"><div class="t">${esc(c.label || q)}</div>
        <div class="s num">на 100 г: ${r0(c.kcal)} ккал · Б ${r1(c.p)} Ж ${r1(c.f)} У ${r1(c.c)} · порция ≈ ${r0(c.portion_g)} г
        ${c.source_url ? ` · <a href="${esc(c.source_url)}" target="_blank" rel="noopener">источник</a>` : ""} ${c.confidence === "low" ? '<span class="tag warn">неуверенно</span>' : ""}</div></div>
        <button class="btn" data-c="${i}">Выбрать</button></div>`).join("") || `<div class="empty">Ничего не нашлось</div>`}</div>
      <button class="btn ghost" id="wBack">Назад</button>`;
    body.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { const c = list[+b.dataset.c]; amountStep(d, meal, { manual: { name: c.label ? `${q} (${c.label})` : q, kcal: c.kcal, p: c.p, f: c.f, c: c.c, portion_g: c.portion_g, src: "ai", note: "Это оценка ИИ, а не расчёт по рецепту." } }); });
    $("#wBack", body).onclick = () => { d.close(); addEntryDialog(meal); };
  } catch (e) { body.innerHTML = `<div class="notice">Не получилось: ${esc(e.message)}</div>`; }
}
async function offSearch(d, meal, q) {
  const body = $(".db", d); body.innerHTML = `<div class="empty">Ищу в Open Food Facts…</div>`;
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=20&fields=product_name,brands,nutriments,countries_tags`;
    const data = await fetch(url).then(r => r.json());
    const list = (data.products || []).map(p => ({ name: [p.product_name, p.brands].filter(Boolean).join(" · "), kcal: p.nutriments?.["energy-kcal_100g"], p: p.nutriments?.proteins_100g, f: p.nutriments?.fat_100g, c: p.nutriments?.carbohydrates_100g, rs: (p.countries_tags || []).includes("en:serbia") })).filter(x => x.name && x.kcal != null)
      .sort((a, b) => b.rs - a.rs);
    body.innerHTML = `<div class="small muted">Данные с упаковок, которые внесли покупатели. Сербские — сверху.</div>
      <div class="res">${list.map((x, i) => `<button data-o="${i}"><span>${esc(x.name)} ${x.rs ? '<span class="tag">RS</span>' : ""}</span><span class="muted small num">${r0(x.kcal)} ккал</span></button>`).join("") || `<div class="empty">Ничего не нашлось</div>`}</div>
      <button class="btn ghost" id="oBack">Назад</button>`;
    body.querySelectorAll("[data-o]").forEach(b => b.onclick = () => { const x = list[+b.dataset.o]; amountStep(d, meal, { manual: { ...x, src: "off" } }); });
    $("#oBack", body).onclick = () => { d.close(); addEntryDialog(meal); };
  } catch (e) { body.innerHTML = `<div class="notice">Не получилось: ${esc(e.message)}</div>`; }
}

/* ---------- Неделя ---------- */
function viewWeek(v) {
  const plan = S.plan;
  v.innerHTML = `<div class="card"><div class="row"><h2 class="grow">Меню на неделю</h2><button class="btn danger" id="wClear">Новая неделя</button></div>
    <p class="small muted" style="margin:6px 0 0">Выберите блюда. «×» — сколько раз готовите это блюдо за неделю (×1 = одна закладка по рецепту, ×1,5 — в полтора раза больше). Список покупок соберётся сам.</p></div>
    ${["breakfast", "lunch", "dinner", "other"].map(m => {
      const items = plan.items.filter(i => (S.recipes[i.rid]?.meal || "other") === m);
      if (m === "other" && !items.length) return "";
      const opts = Object.values(S.recipes).filter(r => r.meal === m).sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));
      return `<div class="card plan-meal"><h2>${RMEALS[m]}</h2>
        ${items.map(i => { const r = S.recipes[i.rid]; const c = calcRecipe(r);
          return `<div class="plan-row"><div class="grow"><b>${esc(r.title)}</b><div class="small muted num">${c.pcs ? `${r0(c.cooked)} шт` : `≈ ${r0(c.yieldW * (i.mult || 1))} г готового`} ${PEOPLE.map(p => c.portions[p.id] ? `· ${p.name} ${r0(c.portions[p.id].v?.kcal)} ккал` : "").join(" ")}</div></div>
          <input class="days" placeholder="дни, напр. пн–ср" value="${esc(i.days || "")}" data-days="${i.id}">
          <label class="small muted">× <input class="mult" type="number" step="0.5" min="0.5" inputmode="decimal" value="${i.mult || 1}" data-mult="${i.id}"></label>
          <button class="btn ghost" data-rm="${i.id}" aria-label="Убрать">✕</button></div>`; }).join("")}
        ${m !== "other" ? `<div class="row"><select data-addto="${m}" class="grow"><option value="">+ добавить блюдо…</option>${opts.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join("")}</select></div>` : ""}
      </div>`;
    }).join("")}
    <button class="btn primary" data-tab="shop">Открыть список покупок →</button>`;
  const savePlan = () => saveKV("plan", S.plan);
  v.querySelectorAll("[data-addto]").forEach(s => s.onchange = () => { if (!s.value) return; S.plan.items.push({ id: uid("w"), rid: s.value, mult: 1, days: "" }); savePlan(); render(); });
  v.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { S.plan.items = S.plan.items.filter(i => i.id !== b.dataset.rm); savePlan(); render(); });
  v.querySelectorAll("[data-days]").forEach(i => i.onchange = () => { S.plan.items.find(x => x.id === i.dataset.days).days = i.value; savePlan(); });
  v.querySelectorAll("[data-mult]").forEach(i => i.onchange = () => { S.plan.items.find(x => x.id === i.dataset.mult).mult = n(i.value) || 1; savePlan(); render(); });
  $("#wClear").onclick = () => openDialog(`<div class="dh"><h2>Начать новую неделю?</h2><button class="btn ghost" data-close>✕</button></div>
    <div class="db">Меню и отметки «куплено» очистятся. Свои пункты в списке покупок (салфетки и т.п.) останутся, отметки с них снимутся.</div>
    <div class="df"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ok">Очистить</button></div>`, d => {
      $("#ok", d).onclick = () => { S.plan = { items: [], extras: (S.plan.extras || []).map(x => ({ ...x, done: false })), checked: {}, home: S.plan.home || {} }; savePlan(); d.close(); render(); };
    });
}

/* ---------- Покупки ---------- */
function shoppingList() {
  const out = {};
  for (const i of S.plan.items) { const r = S.recipes[i.rid]; if (r) rawIngredients(r, i.mult || 1, out); }
  return Object.values(out);
}
function fmtQty(g, name = "") { const q = g >= 1000 ? r1(g / 1000) + " кг" : r0(g) + " г"; return /яйц/i.test(name) && !/желток|белок/i.test(name) ? `${q} (≈ ${Math.ceil(g / 55)} шт)` : q; }
function viewShop(v) {
  const plan = S.plan; plan.checked = plan.checked || {}; plan.home = plan.home || {}; plan.extras = plan.extras || [];
  const items = shoppingList();
  const byCat = {};
  for (const it of items) (byCat[it.cat] = byCat[it.cat] || []).push(it);
  for (const x of plan.extras) (byCat[x.cat || "Своё"] = byCat[x.cat || "Своё"] || []).push({ extra: x });
  const cats = Object.keys(byCat).sort((a, b) => (CATS.indexOf(a) + 1 || 99) - (CATS.indexOf(b) + 1 || 99));
  const showHome = LS.get("showHome", false);
  v.innerHTML = `<div class="card"><div class="row"><h2 class="grow">Список покупок</h2>
      <label class="small row"><input type="checkbox" id="sHome" ${showHome ? "checked" : ""}> показать «есть дома»</label></div>
      <p class="small muted" style="margin:6px 0 0">${plan.items.length ? `Собрано из ${plan.items.length} блюд меню. Граммы — сырой вес по рецептам. «Есть дома» — продукт не попадает в список, пока не снимете отметку (соль, специи, масло).` : `Меню пустое — выберите блюда на вкладке «Неделя».`}</p></div>
    ${cats.map(cat => {
      const rows = byCat[cat].filter(x => x.extra || showHome || !plan.home[x.key]);
      if (!rows.length) return "";
      return `<div class="card shop-cat"><h3>${esc(cat)}</h3>${rows.map(x => x.extra
        ? `<div class="shop-item ${x.extra.done ? "done" : ""}"><input type="checkbox" data-ex="${x.extra.id}" ${x.extra.done ? "checked" : ""}><div class="grow t">${esc(x.extra.name)} <span class="muted small">${esc(x.extra.qty || "")}</span></div><button class="btn ghost" data-exrm="${x.extra.id}" aria-label="Удалить">✕</button></div>`
        : `<div class="shop-item ${plan.checked[x.key] ? "done" : ""}"><input type="checkbox" data-ck="${esc(x.key)}" ${plan.checked[x.key] ? "checked" : ""}>
            <div class="grow"><div class="t">${esc(x.name)} <b class="num">${fmtQty(x.g, x.name)}</b></div><div class="small muted">${[...x.from].map(esc).join(", ")}</div></div>
            <button class="btn ghost small" data-home="${esc(x.key)}">${plan.home[x.key] ? "↩︎ нужно" : "есть дома"}</button></div>`).join("")}</div>`;
    }).join("")}
    <div class="card"><h3>Добавить своё</h3><div class="row" style="margin-top:8px"><input id="eName" class="grow" placeholder="Салфетки, лимонад…"><input id="eQty" style="width:90px" placeholder="кол-во">
      <select id="eCat">${[...CATS, "Бытовые товары", "Своё"].map(c => `<option>${c}</option>`).join("")}</select><button class="btn primary" id="eAdd">Добавить</button></div></div>
    <button class="btn" id="sCopy">Скопировать список текстом</button>`;
  const savePlan = () => saveKV("plan", S.plan);
  $("#sHome").onchange = e => { LS.set("showHome", e.target.checked); render(); };
  v.querySelectorAll("[data-ck]").forEach(c => c.onchange = () => { plan.checked[c.dataset.ck] = c.checked; savePlan(); c.closest(".shop-item").classList.toggle("done", c.checked); });
  v.querySelectorAll("[data-home]").forEach(b => b.onclick = () => { plan.home[b.dataset.home] = !plan.home[b.dataset.home]; savePlan(); render(); });
  v.querySelectorAll("[data-ex]").forEach(c => c.onchange = () => { plan.extras.find(x => x.id === c.dataset.ex).done = c.checked; savePlan(); render(); });
  v.querySelectorAll("[data-exrm]").forEach(b => b.onclick = () => { plan.extras = plan.extras.filter(x => x.id !== b.dataset.exrm); savePlan(); render(); });
  $("#eAdd").onclick = () => { const name = $("#eName").value.trim(); if (!name) return; plan.extras.push({ id: uid("e"), name, qty: $("#eQty").value.trim(), cat: $("#eCat").value, done: false }); savePlan(); render(); };
  $("#sCopy").onclick = () => {
    const txt = cats.map(cat => { const rows = byCat[cat].filter(x => x.extra ? !x.extra.done : (!plan.home[x.key] && !plan.checked[x.key])); return rows.length ? cat + ":\n" + rows.map(x => "— " + (x.extra ? `${x.extra.name} ${x.extra.qty || ""}` : `${x.name} ${fmtQty(x.g, x.name)}`)).join("\n") : ""; }).filter(Boolean).join("\n\n");
    navigator.clipboard?.writeText(txt).then(() => toast("Скопировано"), () => toast("Не получилось скопировать"));
  };
}

/* ---------- Рецепты ---------- */
function viewRecipes(v) {
  if (S.openRecipe && S.recipes[S.openRecipe]) return viewRecipe(v, S.recipes[S.openRecipe]);
  const q = S.rq || "";
  const all = Object.values(S.recipes).filter(r => !q || norm(r.title).includes(norm(q)));
  v.innerHTML = `<div class="row"><input type="search" id="rq" class="grow" placeholder="Поиск рецепта" value="${esc(q)}"><button class="btn primary" id="rNew">+ Новый рецепт</button></div>
    ${["breakfast", "lunch", "dinner", "other"].map(m => {
      const list = all.filter(r => (r.meal || "other") === m).sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));
      if (!list.length) return "";
      return `<div class="card"><h2>${RMEALS[m]}</h2><div class="list" style="margin-top:4px">${list.map(r => {
        const c = calcRecipe(r);
        const bad = c.errors.length ? `<span class="tag warn">нет данных: ${c.errors.length}</span>` : "";
        const nc = c.noCooked ? `<span class="tag warn">нет веса готового</span>` : "";
        return `<div class="li" style="cursor:pointer" data-open="${r.id}"><div class="grow"><div class="t">${esc(r.title)} ${bad} ${nc}</div>
          <div class="s num">${c.pcs ? `1 шт: ${r0(c.perPiece?.kcal)} ккал` : `100 г: ${r0(c.per100?.kcal)} ккал`} ${PEOPLE.map(p => c.portions[p.id] ? ` · ${p.name}: ${r0(c.portions[p.id].v?.kcal)} ккал` : "").join("")}</div></div><span class="muted">›</span></div>`;
      }).join("")}</div></div>`;
    }).join("")}`;
  $("#rq").oninput = e => { S.rq = e.target.value; const pos = e.target.selectionStart; render(); const i = $("#rq"); i.focus(); i.setSelectionRange(pos, pos); };
  v.querySelectorAll("[data-open]").forEach(el => el.onclick = () => { S.openRecipe = el.dataset.open; render(); scrollTo(0, 0); });
  $("#rNew").onclick = async () => {
    const r = { id: uid("r"), meal: "dinner", title: "Новый рецепт", url: null, items: [{ pid: null, name: "", g: 0 }], cooked: null, unit: "g", portions: {}, sort: 999 };
    await save("recipes", r); S.openRecipe = r.id; render();
  };
}

function viewRecipe(v, r0rec) {
  const r = JSON.parse(JSON.stringify(r0rec)); // черновик
  let dirty = false;
  const draw = () => {
    const c = calcRecipe(r);
    const vals = (o, cls = "calc", f = r2) => KEYS.map(k => `<td class="${cls}">${o ? f(o[k]) : "—"}</td>`).join("");
    const usedBy = Object.values(S.products).filter(p => p.recipe_id === r.id);
    v.innerHTML = `<div class="row"><button class="btn ghost" id="rBack">‹ Все рецепты</button><span class="grow"></span>
        <button class="btn primary" id="rSave" ${dirty ? "" : "disabled"}>Сохранить</button></div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <input id="rTitle" value="${esc(r.title)}" style="font:700 19px var(--display)">
        <div class="row"><select id="rMeal">${Object.entries(RMEALS).map(([k, t]) => `<option value="${k}" ${r.meal === k ? "selected" : ""}>${t}</option>`).join("")}</select>
          <input id="rUrl" class="grow" placeholder="Ссылка на рецепт" value="${esc(r.url || "")}">${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">↗</a>` : ""}</div>
        ${c.errors.length ? `<div class="notice">Не посчитано: ${c.errors.map(x => `«${esc(x.it.name)}» — ${x.err}`).join("; ")}. Итог без них.</div>` : ""}
        ${c.noCooked ? `<div class="notice">Вес готового блюда не указан — «в 100 г» считается по сумме сырых продуктов (${r0(c.raw)} г). Взвесьте блюдо после готовки и впишите в строку «всего на блюдо».</div>` : ""}
        ${usedBy.length ? `<div class="small muted">Это блюдо используется как продукт: ${usedBy.map(p => "«" + esc(p.name) + "»").join(", ")} — его «в 100 г» подставляется в другие рецепты.</div>` : ""}
      </div>
      <div class="sheet-wrap"><table class="sheet sticky-first">
        <thead><tr><th rowspan="2">Продукт</th><th rowspan="2">г</th><th colspan="4">На 100 гр</th><th colspan="4">На блюдо</th><th rowspan="2"></th></tr>
          <tr><th>к</th><th>б</th><th>ж</th><th>у</th><th>к</th><th>б</th><th>ж</th><th>у</th></tr></thead>
        <tbody>${c.rows.map((row, i) => `<tr>
          <td class="name"><input list="productNames" data-name="${i}" value="${esc(row.it.name)}" placeholder="продукт…"></td>
          <td class="g"><input type="number" inputmode="decimal" data-g="${i}" value="${row.it.g ?? ""}"></td>
          ${row.err ? `<td class="err" colspan="8">${row.g > 0 || row.it.name ? row.err : ""}</td>` : vals(row.per100, "calc", r1) + vals(row.dish)}
          <td><button class="x" data-rmrow="${i}" aria-label="Удалить строку">✕</button></td></tr>`).join("")}
          <tr><td class="name" colspan="11"><button class="btn ghost small" id="rAdd">+ строка</button></td></tr>
          <tr class="sum"><td class="name">всего на блюдо <span class="muted small">(${c.pcs ? "штук" : "вес готового, г"})</span></td>
            <td class="g"><input type="number" inputmode="decimal" id="rCooked" value="${r.cooked ?? ""}" placeholder="${c.pcs ? "" : r0(c.raw)}"></td>
            <td colspan="4" class="calc small muted">сырые продукты: ${r0(c.raw)} г</td>${vals(c.total)}<td></td></tr>
          <tr class="per"><td class="name">${c.pcs ? "в 1 шт" : "в 100 г."}</td><td></td><td colspan="4"></td>${vals(c.pcs ? c.perPiece : c.per100)}<td></td></tr>
          ${PEOPLE.map(p => `<tr><td class="name">${p.name} <span class="muted small">(${c.pcs ? "шт" : "г"})</span></td>
            <td class="g"><input type="number" inputmode="decimal" data-portion="${p.id}" value="${r.portions?.[p.id] ?? ""}"></td><td colspan="4"></td>
            ${vals(c.portions[p.id]?.v)}<td></td></tr>`).join("")}
        </tbody></table></div>
      <label class="row small"><input type="checkbox" id="rPcs" ${r.unit === "pcs" ? "checked" : ""}> Считать в штуках (бургеры, чебуреки: «всего на блюдо» — число штук)</label>
      <div class="row"><button class="btn" id="rDup">Копия рецепта</button><button class="btn" id="rAsProd">${usedBy.length ? "" : "Использовать как продукт в других рецептах"}</button>
        <span class="grow"></span><button class="btn danger" id="rDel">Удалить рецепт</button></div>`;
    if (usedBy.length) $("#rAsProd").remove();
    const mark = () => { dirty = true; $("#rSave").disabled = false; };
    $("#rBack").onclick = async () => { if (dirty) { r.items = r.items.filter(it => it.name || it.g); await save("recipes", r); toast("Изменения сохранены"); } S.openRecipe = null; render(); };
    $("#rTitle").onchange = e => { r.title = e.target.value; mark(); };
    $("#rMeal").onchange = e => { r.meal = e.target.value; mark(); };
    $("#rUrl").onchange = e => { r.url = e.target.value.trim() || null; mark(); };
    v.querySelectorAll("[data-name]").forEach(i => i.onchange = () => { const it = r.items[+i.dataset.name]; it.name = i.value.trim(); it.pid = productByName(it.name)?.id || null; mark(); keepFocus(() => draw(), i); });
    v.querySelectorAll("[data-g]").forEach(i => i.onchange = () => { r.items[+i.dataset.g].g = n(i.value) || 0; mark(); keepFocus(() => draw(), i); });
    v.querySelectorAll("[data-portion]").forEach(i => i.onchange = () => { r.portions = r.portions || {}; const x = n(i.value); if (x) r.portions[i.dataset.portion] = x; else delete r.portions[i.dataset.portion]; mark(); keepFocus(() => draw(), i); });
    v.querySelectorAll("[data-rmrow]").forEach(b => b.onclick = () => { r.items.splice(+b.dataset.rmrow, 1); mark(); draw(); });
    $("#rAdd").onclick = () => { r.items.push({ pid: null, name: "", g: 0 }); mark(); draw(); v.querySelector(`[data-name="${r.items.length - 1}"]`)?.focus(); };
    $("#rCooked").onchange = e => { r.cooked = n(e.target.value); mark(); keepFocus(() => draw(), e.target); };
    $("#rPcs").onchange = e => { r.unit = e.target.checked ? "pcs" : "g"; mark(); draw(); };
    $("#rSave").onclick = async () => { r.items = r.items.filter(it => it.name || it.g); await save("recipes", r); dirty = false; toast("Сохранено"); draw(); };
    $("#rDup").onclick = async () => { const c2 = { ...JSON.parse(JSON.stringify(r)), id: uid("r"), title: r.title + " (копия)" }; await save("recipes", c2); S.openRecipe = c2.id; render(); };
    const ap = $("#rAsProd"); if (ap) ap.onclick = async () => { await save("recipes", r); await save("products", { id: uid("p"), name: r.title, cat: "Прочее", recipe_id: r.id, source: "из рецепта" }); toast("Добавлен продукт «" + r.title + "»"); draw(); };
    $("#rDel").onclick = () => openDialog(`<div class="dh"><h2>Удалить «${esc(r.title)}»?</h2><button class="btn ghost" data-close>✕</button></div>
      <div class="db">Рецепт удалится насовсем.${usedBy.length ? " Он используется как продукт — такие продукты перестанут считаться." : ""}</div>
      <div class="df"><button class="btn" data-close>Отмена</button><button class="btn danger" id="ok">Удалить</button></div>`, d => {
        $("#ok", d).onclick = async () => { await remove("recipes", r.id); S.plan.items = S.plan.items.filter(i => i.rid !== r.id); saveKV("plan", S.plan); d.close(); S.openRecipe = null; render(); };
      });
  };
  draw();
}
function keepFocus(fn, el) {
  // после пересчёта возвращаем фокус в следующую ячейку, как Tab в таблице
  const sel = el.dataset.name != null ? `[data-g="${el.dataset.name}"]` : el.dataset.g != null ? `[data-name="${+el.dataset.g + 1}"]` : null;
  fn(); if (sel) document.querySelector(sel)?.focus();
}

/* ---------- Продукты ---------- */
function viewProducts(v) {
  const q = S.pq || "";
  const all = Object.values(S.products).filter(p => !q || norm(p.name).includes(norm(q))).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const byCat = {}; for (const p of all) (byCat[p.cat || "Прочее"] = byCat[p.cat || "Прочее"] || []).push(p);
  v.innerHTML = `<div class="row"><input type="search" id="pq" class="grow" placeholder="Поиск продукта" value="${esc(q)}"><button class="btn primary" id="pNew">+ Продукт</button></div>
    <div class="small muted">${Object.keys(S.products).length} продуктов · КБЖУ на 100 г</div>
    ${Object.keys(byCat).sort((a, b) => (CATS.indexOf(a) + 1 || 99) - (CATS.indexOf(b) + 1 || 99)).map(cat => `<div class="card"><h3>${esc(cat)}</h3><div class="list">${byCat[cat].map(p => {
      const v100 = per100OfProduct(p);
      return `<div class="li" style="cursor:pointer" data-edit="${p.id}"><div class="grow"><div class="t">${esc(p.name)} ${p.recipe_id ? '<span class="tag">из рецепта</span>' : ""} ${p.source && !["таблица", "из рецепта"].includes(p.source) ? `<span class="tag">${esc(p.source)}</span>` : ""}</div>
        <div class="s num">${v100 ? `${r0(v100.kcal)} ккал · Б ${r1(v100.p)} Ж ${r1(v100.f)} У ${r1(v100.c)}` : '<span style="color:var(--bad)">нет данных</span>'}</div></div><span class="muted">›</span></div>`;
    }).join("")}</div></div>`).join("")}`;
  $("#pq").oninput = e => { S.pq = e.target.value; const pos = e.target.selectionStart; render(); const i = $("#pq"); i.focus(); i.setSelectionRange(pos, pos); };
  v.querySelectorAll("[data-edit]").forEach(el => el.onclick = () => editProduct(S.products[el.dataset.edit]));
  $("#pNew").onclick = () => editProduct({ id: uid("p"), name: S.pq || "", kcal: null, p: null, f: null, c: null, cat: "Прочее", source: "вручную" }, true);
}
function editProduct(p, isNew) {
  const usedIn = Object.values(S.recipes).filter(r => (r.items || []).some(it => it.pid === p.id || norm(it.name) === norm(p.name)));
  openDialog(`<div class="dh"><h2>${isNew ? "Новый продукт" : "Продукт"}</h2><button class="btn ghost" data-close>✕</button></div><div class="db">
    <label class="f">Название<input id="pName" value="${esc(p.name)}"></label>
    ${p.recipe_id ? `<div class="notice">КБЖУ берётся из рецепта «${esc(S.recipes[p.recipe_id]?.title || "?")}» (строка «в 100 г.»). Меняйте рецепт.</div>` :
      `<div class="small muted">КБЖУ на 100 г</div><div class="grid4">${KEYS.map((k, i) => `<label class="f">${["Ккал", "Белки", "Жиры", "Углеводы"][i]}<input type="number" inputmode="decimal" data-k="${k}" value="${p[k] ?? ""}"></label>`).join("")}</div>
      <button class="btn" id="pPhoto">📷 Заполнить по фото этикетки</button><input type="file" id="pFile" accept="image/*" capture="environment" multiple hidden>`}
    <label class="f">Категория (раздел в списке покупок)<select id="pCat">${[...new Set([...CATS, p.cat || "Прочее"])].map(c => `<option ${c === (p.cat || "Прочее") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
    ${usedIn.length ? `<div class="small muted">Есть в рецептах: ${usedIn.map(r => esc(r.title)).join(", ")}. Изменение КБЖУ пересчитает их.</div>` : ""}
  </div><div class="df">${!isNew && !usedIn.length ? `<button class="btn danger" id="pDel">Удалить</button>` : ""}<span class="grow"></span><button class="btn" data-close>Отмена</button><button class="btn primary" id="pSave">Сохранить</button></div>`, d => {
    const pf = $("#pFile", d);
    if (pf) { $("#pPhoto", d).onclick = () => pf.click(); pf.onchange = async e => {
      const b = $("#pPhoto", d); b.textContent = "Читаю этикетку…"; b.disabled = true;
      try { const images = await Promise.all([...e.target.files].slice(0, 4).map(async f => ({ data: await shrink(f) }))); const x = await callAI({ action: "label", images });
        if (!$("#pName", d).value) $("#pName", d).value = x.name || ""; KEYS.forEach(k => { if (x[k] != null) d.querySelector(`[data-k="${k}"]`).value = x[k]; });
        b.textContent = x.confidence === "low" ? "⚠️ Распознано неуверенно — проверьте" : "✓ Заполнено по этикетке — проверьте"; if (x.note) toast(x.note);
      } catch (err) { b.textContent = "Не получилось: " + err.message; } b.disabled = false; }; }
    $("#pSave", d).onclick = async () => {
      const name = $("#pName", d).value.trim(); if (!name) return toast("Нужно название");
      const dup = productByName(name); if (dup && dup.id !== p.id) return toast("Такой продукт уже есть");
      const out = { ...p, name, cat: $("#pCat", d).value };
      if (!p.recipe_id) for (const k of KEYS) out[k] = n(d.querySelector(`[data-k="${k}"]`).value);
      // переименование — обновим имя в рецептах
      if (!isNew && p.name !== name) for (const r of usedIn) { r.items.forEach(it => { if (it.pid === p.id || norm(it.name) === norm(p.name)) { it.name = name; it.pid = p.id; } }); await save("recipes", r); }
      await save("products", out); d.close(); render();
    };
    const del = $("#pDel", d); if (del) del.onclick = async () => { await remove("products", p.id); d.close(); render(); };
  });
}

/* ---------- старт ---------- */
(async function start() {
  renderChrome(); $("#view").innerHTML = `<div class="empty">Загружаю…</div>`;
  await load(); render();
  if (!SB) status("без сервера: данные только в этом браузере");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
  window.addEventListener("online", () => { flushQueue(); status(""); });
  window.addEventListener("offline", () => status("нет сети"));
})();
