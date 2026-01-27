import "dotenv/config";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import mysql from "mysql2/promise";

/* ================== ENV ================== */
const {
  BOT_TOKEN,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  PORT = 8080,
  PUBLIC_URL,
  ADMIN_TG_ID,
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN відсутній");
if (!MYSQL_HOST) throw new Error("MySQL налаштування відсутні");

/* ================== MYSQL ================== */
const pool = await mysql.createPool({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4_unicode_ci",
});

try {
  const [r] = await pool.query("SELECT NOW() as now");
  console.log("DB connected:", r[0].now);
} catch (e) {
  console.error("DB error:", e);
}

/* ================== EXPRESS ================== */
const app = express();
app.use(express.json());

app.get("/api/ads", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, title, description_adv, media_url, link_url, contact_info
      FROM ads_requests
      WHERE status='active'
      ORDER BY id DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ================== BOT ================== */
const bot = new Telegraf(BOT_TOKEN);

/* ---------- constants ---------- */
const TARIFFS = [
  { days: 1, price: 120, label: "1 день — 120 грн" },
  { days: 7, price: 620, label: "7 днів — 620 грн" },
  { days: 14, price: 1100, label: "14 днів — 1100 грн" },
  { days: 30, price: 2200, label: "30 днів — 2200 грн" },
];

const LIMITS = {
  title: 60,
  desc: 200,
  contact: 120,
  name: 60,
};

const PAYMENT_DETAILS = {
  card: "5375 4111 2233 4455",
  iban: "UA12 3456 7890 1234 5678 9012 345",
};

const state = new Map();

/* ---------- helpers ---------- */
const isValidUrl = (t) => /^https?:\/\/\S+\.\S+/i.test(t);
const isAdmin = (ctx) =>
  ADMIN_TG_ID && String(ctx.from.id) === String(ADMIN_TG_ID);

const mainMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("📝 Оформити рекламу", "MENU_CREATE")],
    [Markup.button.callback("❌ Поки що ні", "MENU_LATER")],
  ]);

const tariffsKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("1 день", "TARIFF_1")],
    [Markup.button.callback("7 днів", "TARIFF_7")],
    [Markup.button.callback("14 днів", "TARIFF_14")],
    [Markup.button.callback("30 днів", "TARIFF_30")],
  ]);

/* ================== START ================== */
bot.start(async (ctx) => {
  state.delete(ctx.from.id);
  const text = TARIFFS.map((t) => t.label).join("\n");

  await ctx.reply(
    `👋 Вітаємо в DeTransport Ads!\n\n💰 Тарифи:\n${text}`,
    mainMenu()
  );
});

/* ================== USER FLOW ================== */
bot.action("MENU_LATER", async (ctx) => {
  await ctx.answerCbQuery();
  state.delete(ctx.from.id);
  await ctx.editMessageText("Добре 🙂 Напишіть /start коли будете готові");
});

bot.action("MENU_CREATE", async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, { step: "tariff" });
  await ctx.editMessageText("Оберіть тариф:", tariffsKb());
});

const chooseTariff = async (ctx, days) => {
  const t = TARIFFS.find((x) => x.days === days);
  if (!t) return;

  state.set(ctx.from.id, {
    step: "title",
    tariff_days: t.days,
    price_uah: t.price,
  });

  await ctx.editMessageText(
    `Обрано ${t.days} днів (${t.price} грн)\n\nНапишіть заголовок`
  );
};

bot.action("TARIFF_1", (ctx) => chooseTariff(ctx, 1));
bot.action("TARIFF_7", (ctx) => chooseTariff(ctx, 7));
bot.action("TARIFF_14", (ctx) => chooseTariff(ctx, 14));
bot.action("TARIFF_30", (ctx) => chooseTariff(ctx, 30));

/* ---------- TEXT ---------- */
bot.on("text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();

  const uid = ctx.from.id;
  const s = state.get(uid);
  const text = ctx.message.text.trim();

  if (!s) return ctx.reply("Натисніть /start");

  if (s.step === "title") {
    state.set(uid, { ...s, step: "desc", title: text });
    return ctx.reply("Напишіть опис");
  }

  if (s.step === "desc") {
    state.set(uid, { ...s, step: "link", description_adv: text });
    return ctx.reply("Надішліть посилання");
  }

  if (s.step === "link") {
    if (!isValidUrl(text)) return ctx.reply("Некоректне посилання");
    state.set(uid, { ...s, step: "contact", link_url: text });
    return ctx.reply("Контактні дані");
  }

  if (s.step === "contact") {
    state.set(uid, { ...s, step: "name", contact_info: text });
    return ctx.reply("Імʼя та прізвище");
  }

  if (s.step === "name") {
    state.set(uid, { ...s, step: "photo", customer_name: text });
    return ctx.reply("Надішліть банер");
  }
});

/* ---------- PHOTO ---------- */
bot.on(["photo", "document"], async (ctx) => {
  const uid = ctx.from.id;
  const s = state.get(uid);
  if (!s || s.step !== "photo") return;

  const fileId =
    ctx.message.photo?.at(-1)?.file_id || ctx.message.document?.file_id;

  const file = await ctx.telegram.getFile(fileId);
  const mediaUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const [res] = await pool.query(
    `INSERT INTO ads_requests
     (tg_id, customer_name, title, description_adv, link_url, contact_info,
      media_url, tariff_days, price_uah, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      uid,
      s.customer_name,
      s.title,
      s.description_adv,
      s.link_url,
      s.contact_info,
      mediaUrl,
      s.tariff_days,
      s.price_uah,
    ]
  );

  state.delete(uid);

  ctx.reply(`✅ Заявка #${res.insertId} створена. Очікуйте перевірки`);
});

/* ================== ADMIN ================== */
bot.command("myid", (ctx) => ctx.reply(`Ваш ID: ${ctx.from.id}`));

bot.command("list_pending", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Немає доступу");

  const [rows] = await pool.query(
    "SELECT id, title, customer_name FROM ads_requests WHERE status='pending'"
  );

  if (!rows.length) return ctx.reply("Немає заявок");

  ctx.reply(
    rows.map((r) => `#${r.id} — ${r.customer_name}\n${r.title}`).join("\n\n")
  );
});

/* ================== START BOT ================== */
if (PUBLIC_URL) {
  const webhookPath = "/tg-webhook";
  await bot.telegram.setWebhook(PUBLIC_URL + webhookPath);
  app.use(bot.webhookCallback(webhookPath));
  app.listen(PORT, () => console.log("Webhook mode"));
} else {
  await bot.launch();
  app.listen(PORT, () => console.log("Polling mode"));
}
