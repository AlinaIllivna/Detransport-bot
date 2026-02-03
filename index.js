import "dotenv/config";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import mysql from "mysql2/promise";
import cors from "cors";

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

if (!BOT_TOKEN) throw new Error("BOT_TOKEN відсутній (.env)");
if (!MYSQL_HOST) throw new Error("MySQL налаштування відсутні (.env)");

// ----------------- MySQL pool -----------------
const pool = await mysql.createPool({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4_unicode_ci",
});

// Перевірка підключення (не обовʼязково, але корисно)
try {
  const [r] = await pool.query("SELECT NOW() as now");
  console.log("DB connected, time =", r[0].now);
} catch (e) {
  console.error("DB connection error:", e);
}

// ----------------- Express -----------------
const app = express();

// ✅ CORS ПЕРШИМ
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://detransport.vercel.app",
    ],
    methods: ["GET", "POST"],
  })
);

app.use(express.json());

// API для сайту: віддати активні оголошення
app.get("/api/ads", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, description_adv, media_url, link_url, contact_info, start_date, end_date
       FROM ads_requests
       WHERE status='active'
         AND (start_date IS NULL OR start_date <= CURDATE())
         AND (end_date   IS NULL OR end_date   >= CURDATE())
       ORDER BY id DESC
       LIMIT 100`
    );

    res.json(rows);
  } catch (e) {
    console.error("GET /api/ads error:", e);
    res.status(500).json({ error: "Server error" });
  }
});


// ----------------- Telegram bot -----------------
const bot = new Telegraf(BOT_TOKEN);

// Тарифи
const TARIFFS = [
  { days: 1, price: 120, label: "✅ 1 день — 120 грн (тест)" },
  { days: 7, price: 620, label: "✅ 7 днів — 620 грн" },
  { days: 14, price: 1100, label: "✅ 14 днів — 1100 грн" },
  { days: 30, price: 2200, label: "✅ 30 днів — 2200 грн" },
];

// Ліміти тексту
const LIMITS = {
  title: 60,
  desc: 200,
  contact: 120,
  name: 60,
};

// Реквізити (поки тестові)
const PAYMENT_DETAILS = {
  card: "5375 4111 2233 4455",
  iban: "UA12 3456 7890 1234 5678 9012 345",
};

// Стан діалогу користувача
// step: menu -> tariff -> title -> desc -> link -> contact -> name -> photo -> wait_receipt
const state = new Map();

// ----------------- helpers -----------------
function isValidUrl(text) {
  return /^https?:\/\/\S+\.\S+/i.test(text);
}

function isAdmin(ctx) {
  if (!ADMIN_TG_ID) return false;
  return String(ctx.from.id) === String(ADMIN_TG_ID);
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📝 Оформити рекламу", "MENU_CREATE")],
    [Markup.button.callback("❌ Поки що ні", "MENU_LATER")],
  ]);
}

function tariffsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1 день", "TARIFF_1")],
    [Markup.button.callback("7 днів", "TARIFF_7")],
    [Markup.button.callback("14 днів", "TARIFF_14")],
    [Markup.button.callback("30 днів", "TARIFF_30")],
    [Markup.button.callback("⬅️ Назад", "BACK_TO_MENU")],
  ]);
}

function getTariffByDays(days) {
  return TARIFFS.find((t) => t.days === days) || null;
}

// ----------------- /start -----------------
bot.start(async (ctx) => {
  state.delete(ctx.from.id);

  const tariffsText = TARIFFS.map((t) => t.label).join("\n");
  const payload = ctx.startPayload;

  if (payload === "order") {
    await ctx.reply(
      "📝 Почнемо оформлення реклами!\n\n" +
      "💰 Тарифи розміщення:\n" +
      `${tariffsText}\n\n` +
      "Натисніть кнопку нижче 👇",
      mainMenuKeyboard()
    );
  } else {
    await ctx.reply(
      "👋 Вітаємо в DeTransport Ads!\n\n" +
      "💰 Тарифи розміщення реклами:\n" +
      `${tariffsText}\n\n` +
      "Натисніть кнопку нижче 👇",
      mainMenuKeyboard()
    );
  }
});




// ----------------- /cancel -----------------
bot.command("cancel", async (ctx) => {
  state.delete(ctx.from.id);
  await ctx.reply("❌ Заявку скасовано. Напиши /start щоб почати заново.");
});

// ----------------- /myid -----------------
bot.command("myid", async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`);
});

// ----------------- Callbacks (inline кнопки) -----------------
bot.action("MENU_LATER", async (ctx) => {
  await ctx.answerCbQuery();
  state.delete(ctx.from.id);
  await ctx.editMessageText(
    "Добре 😊 Якщо захочете оформити рекламу — напишіть /start"
  );
});

bot.action("MENU_CREATE", async (ctx) => {
  await ctx.answerCbQuery();

  state.set(ctx.from.id, { step: "tariff" });

  await ctx.editMessageText("1/7 📆 Оберіть термін розміщення:", tariffsKeyboard());
});

bot.action("BACK_TO_MENU", async (ctx) => {
  await ctx.answerCbQuery();
  state.delete(ctx.from.id);

  const tariffsText = TARIFFS.map((t) => t.label).join("\n");
  await ctx.editMessageText(
    `👋 Вітаємо в DeTransport Ads!\n\n` +
      `💰 Тарифи розміщення реклами:\n${tariffsText}\n\n` +
      `Натисніть кнопку нижче 👇`,
    mainMenuKeyboard()
  );
});

async function chooseTariff(ctx, days) {
  await ctx.answerCbQuery();

  const t = getTariffByDays(days);
  if (!t) return;

  state.set(ctx.from.id, {
    step: "title",
    tariff_days: t.days,
    price_uah: t.price,
  });

  await ctx.editMessageText(
    `✅ Обрано: ${t.days} дн.\n` +
      `💳 Вартість: ${t.price} грн\n\n` +
      `2/7 ✍️ Напиши короткий заголовок (до ${LIMITS.title} символів).`
  );
}

bot.action("TARIFF_1", (ctx) => chooseTariff(ctx, 1));
bot.action("TARIFF_7", (ctx) => chooseTariff(ctx, 7));
bot.action("TARIFF_14", (ctx) => chooseTariff(ctx, 14));
bot.action("TARIFF_30", (ctx) => chooseTariff(ctx, 30));



// ----------------- Photo or receipt -----------------
bot.on(["photo", "document"], async (ctx) => {
  try {
    const uid = ctx.from.id;
    const s = state.get(uid);

    if (!s) {
      return ctx.reply("Щоб оформити рекламу, натисніть /start 🙂");
    }

    // fileId
    let fileId = null;
    if (ctx.message.photo) fileId = ctx.message.photo.at(-1).file_id;
    else if (ctx.message.document) fileId = ctx.message.document.file_id;
    if (!fileId) return;

    const file = await ctx.telegram.getFile(fileId);
    const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // 7/7 — приймаємо банер і записуємо заявку в БД
    if (s.step === "photo") {
      const [result] = await pool.query(
        `INSERT INTO ads_requests
        (tg_id, name_user, customer_name, title, description_adv, link_url, contact_info,
         media_url, tariff_days, price_uah, payment_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'pending')`,
        [
          String(uid),
          ctx.from.first_name || null,
          s.customer_name || null,
          s.title,
          s.description_adv,
          s.link_url,
          s.contact_info,
          tgFileUrl,
          s.tariff_days,
          s.price_uah,
        ]
      );

      const insertId = result.insertId;

      // переводимо в очікування квитанції
      state.set(uid, { step: "wait_receipt", last_request_id: insertId });

      return ctx.reply(
        `✅ Заявка №${insertId} прийнята!\n` +
          `💰 До оплати: ${s.price_uah} грн\n\n` +
          `💳 Картка: ${PAYMENT_DETAILS.card}\n` +
          `🏦 IBAN: ${PAYMENT_DETAILS.iban}\n\n` +
          `🧾 Призначення платежу:\n` +
          `Реклама DeTransport + ${s.customer_name}\n\n` +
          `Після оплати надішліть квитанцію (скрін/фото) сюди ✅`
      );
    }

    // Очікуємо квитанцію
    if (s.step === "wait_receipt") {
      await pool.query(
        `UPDATE ads_requests
         SET payment_proof_url = ?, payment_status = 'waiting_review'
         WHERE id = ?`,
        [tgFileUrl, s.last_request_id]
      );

      state.delete(uid);

      return ctx.reply(
        "✅ Квитанцію отримано!\n" +
          "Очікуйте підтвердження ✅"
      );
    }

    return ctx.reply("Напишіть /start щоб оформити рекламу 🙂");
  } catch (e) {
    console.error("bot media handler error:", e);
    ctx.reply("Не вдалося обробити файл. Спробуйте ще раз 🙏");
  }
});

// 📰 Ловимо пости з Telegram-каналу
bot.on("channel_post", async (ctx) => {
  try {
    const text = ctx.channelPost.text;

    if (!text) return; // ігноруємо пости без тексту

    await db.execute(
      `INSERT INTO news (text, published_at)
       VALUES (?, FROM_UNIXTIME(?))`,
      [
        text,
        ctx.channelPost.date, // timestamp від Telegram
      ]
    );

    console.log("📰 News saved:", text.slice(0, 50));
  } catch (err) {
    console.error("❌ Error saving news:", err);
  }
});


// ----------------- Admin commands -----------------
bot.command("list_pending", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔️ Немає доступу.");

  const [rows] = await pool.query(
    `SELECT id, customer_name, title, price_uah, tariff_days, payment_status, status
     FROM ads_requests
     WHERE status='pending'
     ORDER BY id DESC
     LIMIT 20`
  );

  if (!rows.length) return ctx.reply("✅ Немає заявок pending.");

  const msg = rows
    .map(
      (r) =>
        `#${r.id} | ${r.customer_name || "-"}\n` +
        `${r.title}\n` +
        `💰 ${r.price_uah || "-"} грн | 📆 ${r.tariff_days || "-"} днів\n` +
        `💳 ${r.payment_status} | 📌 ${r.status}\n`
    )
    .join("\n");

  return ctx.reply(msg);
});

bot.command("approve", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔️ Немає доступу.");

  const parts = ctx.message.text.split(" ");
  const id = Number(parts[1]);
  if (!id) return ctx.reply("Формат: /approve 12");

  await pool.query(
    `UPDATE ads_requests
     SET status='active',
         payment_status='paid',
         start_date = CURDATE(),
         end_date = DATE_ADD(CURDATE(), INTERVAL tariff_days DAY)
     WHERE id = ?`,
    [id]
  );

  return ctx.reply(`✅ Заявку #${id} активовано (status=active, payment=paid).`);
});

bot.command("disable", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔️ Немає доступу.");

  const parts = ctx.message.text.split(" ");
  const id = Number(parts[1]);
  if (!id) return ctx.reply("Формат: /disable 12");

  await pool.query(
    `UPDATE ads_requests
     SET status='disabled'
     WHERE id = ?`,
    [id]
  );

  return ctx.reply(`✅ Заявку #${id} вимкнено (status=disabled).`);
});


// ----------------- Text flow -----------------
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  try {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const s = state.get(uid);

    if (!s) {
      return ctx.reply("Щоб оформити рекламу, натисніть /start 🙂");
    }

    // 2/7 title
    if (s.step === "title") {
      if (text.length > LIMITS.title) {
        return ctx.reply(
          `❌ Заголовок занадто довгий. До ${LIMITS.title} символів.`
        );
      }

      state.set(uid, { ...s, step: "desc", title: text });
      return ctx.reply(
        `✅ 3/7 📝 Напиши короткий опис (1–2 речення, до ${LIMITS.desc} символів).`
      );
    }

    // 3/7 desc
    if (s.step === "desc") {
      if (text.length > LIMITS.desc) {
        return ctx.reply(`❌ Опис задовгий. До ${LIMITS.desc} символів.`);
      }

      state.set(uid, { ...s, step: "link", description_adv: text });
      return ctx.reply(
        "✅ 4/7 🔗 Надішли посилання (URL), куди перейти при натисканні на рекламу."
      );
    }

    // 4/7 link
    if (s.step === "link") {
      if (!isValidUrl(text)) {
        return ctx.reply(
          "❌ Це не схоже на посилання. Наприклад: https://instagram.com/..."
        );
      }

      state.set(uid, { ...s, step: "contact", link_url: text });
      return ctx.reply(`✅ 5/7 ☎️ Залиш контакт (телефон / Instagram / Telegram).`);
    }

    // 5/7 contact
    if (s.step === "contact") {
      if (text.length > LIMITS.contact) {
        return ctx.reply(`❌ Контакт задовгий. До ${LIMITS.contact} символів.`);
      }

      state.set(uid, { ...s, step: "name", contact_info: text });
      return ctx.reply("✅ 6/7 👤 Вкажіть ім’я та по батькові (як у квитанції).");
    }

    // 6/7 name
    if (s.step === "name") {
      if (text.length > LIMITS.name) {
        return ctx.reply(`❌ Занадто довго. До ${LIMITS.name} символів.`);
      }

      state.set(uid, { ...s, step: "photo", customer_name: text });
      return ctx.reply("✅ 7/7 🖼 Надішли фото/банер одним повідомленням.");
    }

    // якщо текст замість фото
    if (s.step === "photo") {
      return ctx.reply("📸 Очікую фото/банер. Надішли зображення одним повідомленням 🙂");
    }

    // якщо чекаємо квитанцію
    if (s.step === "wait_receipt") {
      return ctx.reply("🧾 Очікую квитанцію (скрін/фото) одним повідомленням ✅");
    }
  } catch (e) {
    console.error("bot text handler error:", e);
    ctx.reply("На жаль, сталася помилка. Спробуйте ще раз пізніше 🙏");
  }
});
// ----------------- WEBHOOK / POLLING -----------------
if (PUBLIC_URL) {
  const baseUrl = PUBLIC_URL.trim().replace(/\/$/, "");
  const webhookPath = "/tg-webhook";
  const webhookUrl = `${baseUrl}${webhookPath}`;

  app.use(bot.webhookCallback(webhookPath));
  await bot.telegram.setWebhook(webhookUrl);

  app.listen(PORT, () => {
    console.log("HTTP server & webhook on", PORT);
    console.log("Webhook URL:", webhookUrl);
  });
} else {
  app.listen(PORT, () => console.log("HTTP server on", PORT));
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log("Bot started via long polling");
}

// глобальні ловці
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

process.on("SIGINT", () => {
  try {
    bot.stop("SIGINT");
  } catch (e) {}
});

process.on("SIGTERM", () => {
  try {
    bot.stop("SIGTERM");
  } catch (e) {}
});
