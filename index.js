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

// простий стейт-машин для діалогу: title -> description -> contacts -> (optional link) -> save
const state = new Map();

bot.start(ctx => {
  state.delete(ctx.from.id);
  ctx.reply(
    '👋 Вітаємо у DeTransport Ads!\nНапишіть, будь ласка, КОРОТКИЙ заголовок реклами (до 150 символів).'
  );
});

bot.on('text', async ctx => {
  try {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const s = state.get(uid);

    if (!s) {
      // крок 1: заголовок
      if (text.length > 150) {
        return ctx.reply('Заголовок завеликий. Спробуйте коротше (до 150 символів).');
      }
      state.set(uid, { step: 'title', title: text });
      return ctx.reply('Дякую! Тепер опишіть рекламне повідомлення (детальний опис).');
    }

    if (s.step === 'title') {
      // крок 2: опис
      state.set(uid, { ...s, step: 'desc', description: text });
      return ctx.reply('Добре! Тепер залиште контактні дані (телефон / email / @username).');
    }

    if (s.step === 'desc') {
      // крок 3: контакти
      state.set(uid, { ...s, step: 'contacts', contact_info: text });
      return ctx.reply('Чудово! Хочете додати посилання "Детальніше/Перейти"? Якщо ні — напишіть "ні".');
    }

    if (s.step === 'contacts') {
      // крок 4: посилання (необовʼязково)
      let link = null;
      const lower = text.toLowerCase();

      if (lower !== 'ні' && lower !== 'ні.') {
        link = text;
      }

      // збереження в БД (мінімальний набір полів)
      await pool.query(
        `INSERT INTO ads_requests
         (tg_id, name_user, title, description_adv, link_url, media_type, media_url, contact_info, payment_status, status)
         VALUES (?, ?, ?, ?, ?, 'none', NULL, ?, 'unpaid', 'pending')`,
        [String(uid), ctx.from.first_name || null, s.title, s.description, link, s.contact_info]
      );

      state.delete(uid);

      return ctx.reply(
        '✅ Заявку збережено! Можете надіслати фото/логотип одним повідомленням — я додам його до останньої заявки.\nАбо введіть /start, щоб створити нову заявку.'
      );
    }
  } catch (e) {
    console.error('bot text handler error:', e);
    ctx.reply('На жаль, сталася помилка. Спробуйте ще раз пізніше 🙏');
  }
});

// медіа: додамо фото до останнього запису користувача
bot.on(['photo', 'document'], async ctx => {
  try {
    const uid = ctx.from.id;

    let fileId = null;
    if (ctx.message.photo) fileId = ctx.message.photo.at(-1).file_id;
    else if (ctx.message.document) fileId = ctx.message.document.file_id;

    if (!fileId) return;

    const file = await ctx.telegram.getFile(fileId);
    const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // оновлюємо останній запис цього користувача
    await pool.query(
      `UPDATE ads_requests
       SET media_type = 'photo', media_url = ?
       WHERE id = (
         SELECT id FROM (
           SELECT id FROM ads_requests
           WHERE tg_id = ?
           ORDER BY created_at DESC
           LIMIT 1
         ) t
       )`,
      [tgUrl, String(uid)]
    );

    return ctx.reply('🖼 Додав(ла) фото/файл до останньої заявки. Дякую!');
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
