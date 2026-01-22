import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import mysql from 'mysql2/promise';

const {
  BOT_TOKEN,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  PORT = 8080,
  PUBLIC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN відсутній (.env)');
if (!MYSQL_HOST) throw new Error('MySQL налаштування відсутні (.env)');

// Пул підключень до MySQL
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
  charset: 'utf8mb4_unicode_ci'
});

// Перевірка зʼєднання
try {
  const [r] = await pool.query('SELECT NOW() as now');
  console.log('DB connected, time =', r[0].now);
} catch (e) {
  console.error('DB connection error:', e);
}

const app = express();
app.use(express.json());

// API для сайту: віддати активні оголошення в періоді
app.get('/api/ads', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, description_adv, media_url, link_url, contact_info, start_date, end_date, created_at
       FROM ads_requests
       WHERE status='active'
         AND (start_date IS NULL OR start_date <= CURDATE())
         AND (end_date   IS NULL OR end_date   >= CURDATE())
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/ads error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --------- Телеграм-бот ---------
const bot = new Telegraf(BOT_TOKEN);

// Ліміти для красивого дизайну на сайті
const LIMITS = {
  title: 60,
  desc: 200,
  contact: 120,
};

// простий стейт-машин
// steps: title -> desc -> link -> contact -> photo
const state = new Map();

// допоміжна функція: перевірка URL
function isValidUrl(text) {
  return /^https?:\/\/\S+\.\S+/i.test(text);
}

bot.start(ctx => {
  state.delete(ctx.from.id);
  ctx.reply(
    `👋 Привіт! Давай оформимо рекламу для сайту DeTransport.\n` +
    `1/5 ✍️ Напиши короткий заголовок (до ${LIMITS.title} символів).`
  );
});

bot.command('cancel', ctx => {
  state.delete(ctx.from.id);
  ctx.reply('❌ Заявку скасовано. Напиши /start щоб почати заново.');
});

// текстові повідомлення
bot.on('text', async ctx => {
  try {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const s = state.get(uid);

    // Якщо користувач ще не почав
    if (!s) {
      if (text.length > LIMITS.title) {
        return ctx.reply(`❌ Заголовок занадто довгий. Спробуй коротше (до ${LIMITS.title} символів).`);
      }

      state.set(uid, { step: 'title', title: text });

      return ctx.reply(`✅ 2/5 📝 Напиши короткий опис (1–2 речення, до ${LIMITS.desc} символів).`);
    }

    // Крок 2 — опис
    if (s.step === 'title') {
      if (text.length > LIMITS.desc) {
        return ctx.reply(`❌ Опис задовгий. Спробуй коротше (до ${LIMITS.desc} символів).`);
      }

      state.set(uid, { ...s, step: 'desc', description: text });

      return ctx.reply('✅ 3/5 🔗 Надішли посилання (URL), куди перейти при натисканні на рекламу.');
    }

    // Крок 3 — посилання
    if (s.step === 'desc') {
      if (!isValidUrl(text)) {
        return ctx.reply('❌ Це не схоже на посилання. Надішли URL (наприклад: https://instagram.com/...)');
      }

      state.set(uid, { ...s, step: 'link', link_url: text });

      return ctx.reply(`✅ 4/5 ☎️ Залиш контакт (телефон / Instagram / Telegram, до ${LIMITS.contact} символів).`);
    }

    // Крок 4 — контакт
    if (s.step === 'link') {
      if (text.length > LIMITS.contact) {
        return ctx.reply(`❌ Контакт задовгий. Спробуй коротше (до ${LIMITS.contact} символів).`);
      }

      state.set(uid, { ...s, step: 'contact', contact_info: text });

      return ctx.reply('✅ 5/5 🖼 Надішли фото/банер одним повідомленням.');
    }

    // Якщо користувач пише текст замість фото
    if (s.step === 'contact') {
      return ctx.reply('📸 Очікую фото/банер. Надішли зображення одним повідомленням 🙂');
    }

  } catch (e) {
    console.error('bot text handler error:', e);
    ctx.reply('На жаль, сталася помилка. Спробуйте ще раз пізніше 🙏');
  }
});

// Фото/файл — фінальний крок
bot.on(['photo', 'document'], async ctx => {
  try {
    const uid = ctx.from.id;
    const s = state.get(uid);

    // Якщо людина не проходила кроки — просимо почати
    if (!s) {
      return ctx.reply('Щоб створити рекламу, напиши /start 🙂');
    }

    // Файл
    let fileId = null;
    if (ctx.message.photo) fileId = ctx.message.photo.at(-1).file_id;
    else if (ctx.message.document) fileId = ctx.message.document.file_id;

    if (!fileId) return;

    const file = await ctx.telegram.getFile(fileId);
    const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // ⚠️ Тут ми тільки готуємо дані.
    // Запис у БД додамо після того, як ти створиш таблицю.
    // (Тому зараз просто показуємо підтвердження)

    state.delete(uid);

    return ctx.reply(
      `🎉 Готово! Заявка прийнята ✅\n` +
      `Після підтвердження та оплати реклама зʼявиться на сайті.\n\n` +
      `📌 Дані:\n` +
      `• Заголовок: ${s.title}\n` +
      `• Опис: ${s.description}\n` +
      `• Посилання: ${s.link_url}\n` +
      `• Контакт: ${s.contact_info}\n` +
      `• Фото: додано ✅`
    );

  } catch (e) {
    console.error('bot media handler error:', e);
    ctx.reply('Не вдалося обробити файл. Спробуйте ще раз 🙏');
  }
});

// ---------------- WEBHOOK / POLLING ----------------
if (PUBLIC_URL) {
  // ✅ прибираємо перенос рядка і пробіли
  const baseUrl = PUBLIC_URL.trim().replace(/\/$/, '');

  const webhookPath = '/tg-webhook';
  const webhookUrl = `${baseUrl}${webhookPath}`;

  // приймаємо webhook
  app.use(bot.webhookCallback(webhookPath));

  // ставимо webhook в Telegram
  await bot.telegram.setWebhook(webhookUrl);

  app.listen(PORT, () => {
    console.log('HTTP server & webhook on', PORT);
    console.log('Webhook URL:', webhookUrl);
  });
} else {
  // long polling локально
  app.listen(PORT, () => console.log('HTTP server on', PORT));

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();

  console.log('Bot started via long polling');
}

// глобальні ловці
process.on('unhandledRejection', err => console.error('unhandledRejection', err));
process.on('uncaughtException', err => console.error('uncaughtException', err));

process.on('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch (e) {}
});

process.on('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch (e) {}
});
