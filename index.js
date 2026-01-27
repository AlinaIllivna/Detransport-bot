import "dotenv/config";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import mysql from "mysql2/promise";

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

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!MYSQL_HOST) throw new Error("MySQL config missing");

// ----------------- MySQL -----------------
const pool = await mysql.createPool({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 5,
  charset: "utf8mb4_unicode_ci",
});

const app = express();
app.use(express.json());

// ----------------- Telegram bot -----------------
const bot = new Telegraf(BOT_TOKEN);

// ----------------- DATA -----------------
const TARIFFS = [
  { days: 1, price: 120, label: "✅ 1 день — 120 грн (тест)" },
  { days: 7, price: 620, label: "✅ 7 днів — 620 грн" },
  { days: 14, price: 1100, label: "✅ 14 днів — 1100 грн" },
  { days: 30, price: 2200, label: "✅ 30 днів — 2200 грн" },
];

const LIMITS = { title: 60, desc: 200, contact: 120, name: 60 };

const PAYMENT_DETAILS = {
  card: "5375 4111 2233 4455",
  iban: "UA12 3456 7890 1234 5678 9012 345",
};

const state = new Map();

// ----------------- HELPERS -----------------
const isValidUrl = (t) => /^https?:\/\/\S+\.\S+/i.test(t);

const isAdmin = (ctx) =>
  ADMIN_TG_ID && String(ctx.from.id) === String(ADMIN_TG_ID);

const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("📝 Оформити рекламу", "MENU_CREATE")],
    [Markup.button.callback("❌ Поки що ні", "MENU_LATER")],
  ]);

const tariffsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("1 день", "TARIFF_1")],
    [Markup.button.callback("7 днів", "TARIFF_7")],
    [Markup.button.callback("14 днів", "TARIFF_14")],
    [Markup.button.callback("30 днів", "TARIFF_30")],
  ]);

// ----------------- START -----------------
bot.start(async (ctx) => {
  state.delete(ctx.from.id);
  const tariffs = TARIFFS.map((t) => t.label).join("\n");

  await ctx.reply(
    "👋 Вітаємо в DeTransport Ads!\n\n" +
      "💰 Тарифи:\n" +
      tariffs +
      "\n\nНатисніть кнопку нижче 👇",
    mainMenuKeyboard()
  );
});

// ----------------- COMMANDS -----------------
bot.command("myid", (ctx) =>
  ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`)
);

bot.command("cancel", (ctx) => {
  state.delete(ctx.from.id);
  return ctx.reply("❌ Заявку скасовано. Напишіть /start");
});

// 🔥 АДМІН
bot.command("list_pending", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔️ Немає доступу.");

  const [rows] = await pool.query(
    "SELECT id, title, price_uah FROM ads_requests WHERE status='pending'"
  );

  if (!rows.length) return ctx.reply("✅ Немає заявок pending.");

  return ctx.reply(
    rows.map((r) => `#${r.id} | ${r.title} | ${r.price_uah} грн`).join("\n")
  );
});

// ----------------- CALLBACKS -----------------
bot.action("MENU_CREATE", async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, { step: "title" });
  await ctx.reply("✍️ Введіть заголовок реклами:");
});

bot.action("MENU_LATER", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Добре 🙂 Напишіть /start");
});

// ----------------- TEXT FLOW -----------------
bot.on("text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();

  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const s = state.get(uid);

  if (!s) return ctx.reply("Напишіть /start");

  if (s.step === "title") {
    state.set(uid, { ...s, step: "done", title: text });
    return ctx.reply("✅ Заголовок збережено");
  }
});

// ----------------- WEBHOOK -----------------
if (PUBLIC_URL) {
  const webhookPath = "/tg-webhook";
  app.use(bot.webhookCallback(webhookPath));
  await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`);
  app.listen(PORT);
} else {
  await bot.launch();
}
