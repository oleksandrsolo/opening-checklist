// 23.Ресторани · Telegram-бот чеклиста відкриття
// Supabase Edge Function (Deno). Деплой: supabase functions deploy telegram-bot --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const REPORT_CHAT_ID = Deno.env.get("REPORT_CHAT_ID") ?? ""; // група керівників (необовʼязково)
// Сторінка-камера (Mini App). Якщо задано — фото приймаються ТІЛЬКИ з неї.
const CAMERA_URL = Deno.env.get("CAMERA_URL") ?? "";
const TZ = "Europe/Kyiv";
const BUCKET = "checklist-photos";
const API = `https://api.telegram.org/bot${TOKEN}`;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------- types ----------------
type Staff = {
  telegram_id: number; username: string | null; full_name: string | null;
  restaurant_id: number | null; active: boolean;
};
type Item = {
  id: number; section: string; question: string; hint: string | null;
  answer_type: "yes_no" | "number" | "text" | "photo";
  photo_required: boolean; ok_min: number | null; ok_max: number | null;
};
type Sub = {
  id: string; restaurant_id: number; telegram_id: number; staff_name: string | null;
  status: string; current_index: number; step: "answer" | "comment" | "photo";
  work_date: string; started_at: string;
};

// ---------------- telegram helpers ----------------
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("tg", method, j.description);
  return j.result;
}
const send = (chat_id: number | string, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BTN_START = "▶️ Почати чеклист відкриття";
const BTN_STATUS = "ℹ️ Мій статус";
const MAIN_KB = { keyboard: [[{ text: BTN_START }], [{ text: BTN_STATUS }]], resize_keyboard: true };
const NO_KB = { remove_keyboard: true };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const hhmm = (iso: string) =>
  new Intl.DateTimeFormat("uk-UA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

// ---------------- data helpers ----------------
async function getStaff(id: number): Promise<Staff | null> {
  const { data } = await db.from("staff").select("*").eq("telegram_id", id).maybeSingle();
  return data;
}
async function getItems(restaurantId: number): Promise<Item[]> {
  const { data, error } = await db.from("checklist_items").select("*")
    .eq("active", true)
    .or(`restaurant_id.is.null,restaurant_id.eq.${restaurantId}`)
    .order("position").order("id");
  if (error) throw error;
  return data ?? [];
}
async function getOpenSub(uid: number): Promise<Sub | null> {
  const { data } = await db.from("submissions").select("*")
    .eq("telegram_id", uid).eq("status", "in_progress")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  return data;
}
async function setSub(sub: Sub, patch: Partial<Sub>) {
  Object.assign(sub, patch);
  const { error } = await db.from("submissions").update(patch).eq("id", sub.id);
  if (error) throw error;
}
async function saveAnswer(sub: Sub, item: Item, patch: Record<string, unknown>) {
  const { error } = await db.from("answers").upsert({
    submission_id: sub.id, item_id: item.id, section: item.section, question: item.question,
    answered_at: new Date().toISOString(), ...patch,
  }, { onConflict: "submission_id,item_id" });
  if (error) throw error;
}
async function restaurantName(id: number) {
  const { data } = await db.from("restaurants").select("name").eq("id", id).single();
  return data?.name ?? `#${id}`;
}

// ---------------- entry point ----------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-tg-init-data",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  // Фото зі сторінки-камери
  if (new URL(req.url).pathname.endsWith("/photo")) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      return await onCameraUpload(req);
    } catch (e) {
      console.error(e);
      return json({ error: "Не вдалося зберегти фото. Спробуй ще раз." }, 500);
    }
  }
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json();
  try {
    await handle(update);
  } catch (e) {
    console.error(e);
    const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chat) await send(chat, "⚠️ Сталася помилка. Спробуй ще раз або напиши /start.");
  }
  return new Response("ok"); // завжди 200, щоб Telegram не повторював апдейт
});

async function handle(u: any) {
  if (u.callback_query) return onCallback(u.callback_query);
  const m = u.message;
  if (!m || m.chat.type !== "private") return;
  const uid: number = m.from.id;
  const chat: number = m.chat.id;
  const text: string = (m.text ?? "").trim();

  // --- реєстрація ---
  let staff = await getStaff(uid);
  if (!staff) {
    await db.from("staff").insert({ telegram_id: uid, username: m.from.username ?? null });
    return send(chat, "Привіт! Це бот чеклиста відкриття 23.Ресторани.\n\nНапиши своє <b>імʼя та прізвище</b>.", { reply_markup: NO_KB });
  }
  if (!staff.full_name) {
    if (!text || text.startsWith("/")) return send(chat, "Напиши своє <b>імʼя та прізвище</b>.");
    await db.from("staff").update({ full_name: text.slice(0, 80) }).eq("telegram_id", uid);
    return askRestaurant(chat);
  }
  if (!staff.restaurant_id) return askRestaurant(chat);
  if (!staff.active) {
    return send(chat, "⏳ Заявку отримано. Керівник має підтвердити доступ — після цього зможеш заповнювати чеклист.");
  }

  // --- команди ---
  if (text === "/start") {
    return send(chat, `Привіт, ${esc(staff.full_name)}! Готовий до відкриття?`, { reply_markup: MAIN_KB });
  }
  if (text === "/cancel") {
    const s = await getOpenSub(uid);
    if (s) await setSub(s, { status: "abandoned" });
    return send(chat, s ? "Чеклист скасовано." : "Немає активного чеклиста.", { reply_markup: MAIN_KB });
  }
  if (text === BTN_START || text === "/open") return startChecklist(staff, chat);
  if (text === BTN_STATUS || text === "/status") return showStatus(staff, chat);

  // --- відповідь на поточний пункт ---
  const sub = await getOpenSub(uid);
  if (!sub) return send(chat, "Натисни «Почати чеклист відкриття».", { reply_markup: MAIN_KB });
  return onAnswer(sub, m, chat);
}

async function askRestaurant(chat: number) {
  const { data } = await db.from("restaurants").select("id,name").eq("active", true).order("name");
  const rows = (data ?? []).map((r) => [{ text: r.name, callback_data: `reg:${r.id}` }]);
  return send(chat, "У якому ресторані працюєш?", { reply_markup: { inline_keyboard: rows } });
}

async function showStatus(staff: Staff, chat: number) {
  const name = await restaurantName(staff.restaurant_id!);
  const { data } = await db.from("v_submissions").select("work_date,completed_at,problems_cnt")
    .eq("telegram_id", staff.telegram_id).eq("status", "completed")
    .order("completed_at", { ascending: false }).limit(1).maybeSingle();
  const last = data
    ? `${data.work_date.split("-").reverse().join(".")} о ${hhmm(data.completed_at)}, проблем: ${data.problems_cnt}`
    : "ще не було";
  return send(chat, `👤 ${esc(staff.full_name!)}\n🍽 ${esc(name)}\n🕘 Останній чеклист: ${last}`, { reply_markup: MAIN_KB });
}

// ---------------- checklist flow ----------------
async function startChecklist(staff: Staff, chat: number) {
  const open = await getOpenSub(staff.telegram_id);
  if (open) {
    if (open.work_date === today()) {
      await send(chat, "Продовжуємо чеклист з місця, де зупинились.", { reply_markup: NO_KB });
      return askCurrent(open, chat);
    }
    await setSub(open, { status: "abandoned" });
  }
  const items = await getItems(staff.restaurant_id!);
  if (!items.length) return send(chat, "Для твого ресторану ще немає пунктів чеклиста.");
  const { data, error } = await db.from("submissions").insert({
    restaurant_id: staff.restaurant_id, telegram_id: staff.telegram_id,
    staff_name: staff.full_name, work_date: today(),
  }).select().single();
  if (error) throw error;
  const name = await restaurantName(staff.restaurant_id!);
  await send(chat, `🚀 Відкриття <b>${esc(name)}</b> — ${items.length} пунктів.\nСкасувати: /cancel`, { reply_markup: NO_KB });
  return askCurrent(data as Sub, chat);
}

function effectiveStep(sub: Sub, item: Item) {
  return item.answer_type === "photo" && sub.step === "answer" ? "photo" : sub.step;
}

async function askCurrent(sub: Sub, chat: number) {
  const items = await getItems(sub.restaurant_id);
  if (sub.current_index >= items.length) return finish(sub, chat, items);
  const item = items[sub.current_index];
  const step = effectiveStep(sub, item);
  const head = `<b>${sub.current_index + 1}/${items.length} · ${esc(item.section)}</b>\n`;

  if (step === "comment") {
    return send(chat, "✍️ Опиши коротко, що не так і що робиш, щоб виправити.");
  }
  if (step === "photo") return askPhoto(sub, item, chat, head);
  const hint = item.hint && !item.photo_required ? `\n<i>${esc(item.hint)}</i>` : "";
  const body = head + esc(item.question) + hint;
  if (item.answer_type === "yes_no") {
    return send(chat, body, {
      reply_markup: { inline_keyboard: [[
        { text: "✅ Так", callback_data: `yn:${sub.current_index}:${item.id}:1` },
        { text: "❌ Ні", callback_data: `yn:${sub.current_index}:${item.id}:0` },
      ]] },
    });
  }
  if (item.answer_type === "number") return send(chat, body + "\n\nВведи число.");
  return send(chat, body + "\n\nНапиши відповідь.");
}

// after main answer: comment if problem → photo if required → next item
async function afterAnswer(sub: Sub, item: Item, problem: boolean, chat: number) {
  if (problem) await setSub(sub, { step: "comment" });
  else if (item.photo_required) await setSub(sub, { step: "photo" });
  else await setSub(sub, { current_index: sub.current_index + 1, step: "answer" });
  return askCurrent(sub, chat);
}

async function onAnswer(sub: Sub, m: any, chat: number) {
  const items = await getItems(sub.restaurant_id);
  const item = items[sub.current_index];
  if (!item) return finish(sub, chat, items);
  const step = effectiveStep(sub, item);
  const text: string = (m.text ?? m.caption ?? "").trim();

  if (step === "photo") {
    if (CAMERA_URL) {
      await send(chat, "🚫 Фото з галереї чи чату не приймаються — лише знімок через камеру бота.");
      return askPhoto(sub, item, chat, "");
    }
    const fileId = m.photo?.at(-1)?.file_id
      ?? (m.document?.mime_type?.startsWith("image/") ? m.document.file_id : null);
    if (!fileId) return send(chat, "Потрібне саме фото 📷 — зроби знімок і надішли.");
    const path = await savePhoto(sub, item, fileId);
    await saveAnswer(sub, item, { photo_path: path });
    await setSub(sub, { current_index: sub.current_index + 1, step: "answer" });
    return askCurrent(sub, chat);
  }

  if (step === "comment") {
    if (!text) return send(chat, "Напиши коментар текстом.");
    await saveAnswer(sub, item, { comment: text.slice(0, 1000) });
    if (item.photo_required) await setSub(sub, { step: "photo" });
    else await setSub(sub, { current_index: sub.current_index + 1, step: "answer" });
    return askCurrent(sub, chat);
  }

  // step === "answer"
  if (item.answer_type === "yes_no") {
    const t = text.toLowerCase();
    if (["так", "yes", "+"].includes(t)) return answerYesNo(sub, item, true, chat);
    if (["ні", "no", "-"].includes(t)) return answerYesNo(sub, item, false, chat);
    return send(chat, "Натисни ✅ Так або ❌ Ні під питанням.");
  }
  if (item.answer_type === "number") {
    const n = Number(text.replace(",", ".").replace(/\s/g, ""));
    if (!text || Number.isNaN(n)) return send(chat, "Потрібне число, напр. 4 або -18.");
    const bad = (item.ok_min !== null && n < Number(item.ok_min)) || (item.ok_max !== null && n > Number(item.ok_max));
    await saveAnswer(sub, item, { value_number: n, is_problem: bad });
    if (bad) await send(chat, `⚠️ Поза нормою (${item.ok_min ?? "…"} – ${item.ok_max ?? "…"}).`);
    return afterAnswer(sub, item, bad, chat);
  }
  // text
  if (!text) return send(chat, "Напиши відповідь текстом.");
  await saveAnswer(sub, item, { value_text: text.slice(0, 2000) });
  return afterAnswer(sub, item, false, chat);
}

async function answerYesNo(sub: Sub, item: Item, yes: boolean, chat: number) {
  await saveAnswer(sub, item, { value_bool: yes, is_problem: !yes });
  return afterAnswer(sub, item, !yes, chat);
}

async function askPhoto(sub: Sub, item: Item, chat: number, head: string) {
  const q = item.answer_type === "photo" ? head + esc(item.question) + "\n\n" : "";
  const what = item.hint ? `: ${esc(item.hint)}` : "";
  if (!CAMERA_URL) return send(chat, `${q}📷 Надішли фото${what}.`);
  const url = `${CAMERA_URL}?s=${sub.id}&i=${item.id}&t=${encodeURIComponent(item.hint ?? item.question)}`;
  return send(chat, `${q}📷 Зроби фото${what}.\nНатисни кнопку — відкриється камера.`, {
    reply_markup: { inline_keyboard: [[{ text: "📷 Зробити фото", web_app: { url } }]] },
  });
}

// Перевірка підпису Telegram Mini App (initData) → telegram user id або null
async function verifyInitData(initData: string): Promise<number | null> {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const hmac = async (key: BufferSource, data: string) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  };
  const secret = await hmac(enc.encode("WebAppData"), TOKEN);
  const sig = await hmac(secret, dcs);
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") ?? 0) > 3 * 3600) return null;
  try {
    return JSON.parse(p.get("user") ?? "{}").id ?? null;
  } catch {
    return null;
  }
}

async function onCameraUpload(req: Request) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const uid = await verifyInitData(req.headers.get("x-tg-init-data") ?? "");
  if (!uid) return json({ error: "Сесія недійсна. Відкрий камеру кнопкою в боті ще раз." }, 401);
  const qs = new URL(req.url).searchParams;
  const { data: sub } = await db.from("submissions").select("*").eq("id", qs.get("s") ?? "").maybeSingle();
  if (!sub || Number(sub.telegram_id) !== uid || sub.status !== "in_progress") {
    return json({ error: "Цей чеклист уже не активний." }, 409);
  }
  const items = await getItems(sub.restaurant_id);
  const item = items[sub.current_index];
  if (!item || String(item.id) !== qs.get("i") || effectiveStep(sub, item) !== "photo") {
    return json({ error: "Це фото вже не потрібне — повернись у чат." }, 409);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 5_000 || bytes.length > 10_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return json({ error: "Некоректне фото." }, 400);
  }
  const path = await uploadPhoto(sub, item, bytes);
  await saveAnswer(sub, item, { photo_path: path });
  await setSub(sub, { current_index: sub.current_index + 1, step: "answer" });
  await send(uid, "✅ Фото збережено.");
  await askCurrent(sub, uid);
  return json({ ok: true });
}

async function savePhoto(sub: Sub, item: Item, fileId: string) {
  const f = await tg("getFile", { file_id: fileId });
  if (!f?.file_path) throw new Error("getFile failed");
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  return uploadPhoto(sub, item, new Uint8Array(await r.arrayBuffer()));
}

async function uploadPhoto(sub: Sub, item: Item, bytes: Uint8Array) {
  const path = `${sub.restaurant_id}/${sub.work_date}/${sub.id}/${item.id}-${Date.now()}.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (error) throw error;
  return path;
}

async function finish(sub: Sub, chat: number, items: Item[]) {
  const done = new Date().toISOString();
  await setSub(sub, { status: "completed", completed_at: done } as Partial<Sub>);
  const { data: probs } = await db.from("answers").select("question,comment,value_number")
    .eq("submission_id", sub.id).eq("is_problem", true);
  const mins = Math.round((Date.parse(done) - Date.parse(sub.started_at)) / 60000);
  const name = await restaurantName(sub.restaurant_id);
  const list = (probs ?? []).map((p) =>
    `• ${esc(p.question ?? "")}${p.value_number !== null ? ` (${p.value_number})` : ""}${p.comment ? `\n  ↳ ${esc(p.comment)}` : ""}`
  ).join("\n");

  await send(chat,
    `✅ Чеклист завершено за ${mins} хв. Пунктів: ${items.length}, проблем: ${probs?.length ?? 0}.\nДякую!`,
    { reply_markup: MAIN_KB });

  if (REPORT_CHAT_ID) {
    const icon = probs?.length ? "🟠" : "🟢";
    await send(REPORT_CHAT_ID,
      `${icon} <b>${esc(name)}</b> відкрито о ${hhmm(done)}\n👤 ${esc(sub.staff_name ?? "")} · ${mins} хв` +
      (list ? `\n\n<b>Проблеми:</b>\n${list}` : "\nБез зауважень"));
  }
}

// ---------------- buttons ----------------
async function onCallback(q: any) {
  const uid: number = q.from.id;
  const chat: number = q.message?.chat?.id;
  const data: string = q.data ?? "";
  await tg("answerCallbackQuery", { callback_query_id: q.id });

  if (data.startsWith("reg:")) {
    const staff = await getStaff(uid);
    if (!staff?.full_name || staff.active) return;
    const rid = Number(data.slice(4));
    await db.from("staff").update({ restaurant_id: rid }).eq("telegram_id", uid);
    const name = await restaurantName(rid);
    await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `Ресторан: ${name}` });
    await send(chat, "⏳ Заявку надіслано. Керівник підтвердить доступ у панелі звітів.");
    if (REPORT_CHAT_ID) {
      await send(REPORT_CHAT_ID, `🆕 Новий працівник чекає підтвердження: <b>${esc(staff.full_name)}</b> (${esc(name)})`);
    }
    return;
  }

  if (data.startsWith("yn:")) {
    const [, idx, itemId, v] = data.split(":");
    const sub = await getOpenSub(uid);
    if (!sub || sub.step !== "answer" || String(sub.current_index) !== idx) return; // стара кнопка
    const items = await getItems(sub.restaurant_id);
    const item = items[sub.current_index];
    if (!item || String(item.id) !== itemId) return;
    const yes = v === "1";
    await tg("editMessageText", {
      chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML",
      text: `${esc(q.message.text ?? item.question)}\n\n${yes ? "✅ Так" : "❌ Ні"}`,
    });
    return answerYesNo(sub, item, yes, chat);
  }
}
