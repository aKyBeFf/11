const TeleBot = require("node-telegram-bot-api");
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, updateDoc, onSnapshot } = require("firebase/firestore");
const express = require("express");
const dgram = require("dgram");

// ── Ping-сервер для UptimeRobot ───────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("PCLink bot is running"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 HTTP сервер запущен"));

// ── Config ────────────────────────────────────────────────────────────
const BOT_TOKEN = "8653027213:AAFRFSjfDRFqImfHLXkXBQjXkcMT30eMAHc";

const firebaseConfig = {
  apiKey: "AIzaSyDdunIxBJEyVnVsKdmQHB1JBXZsAE7QTMs",
  authDomain: "minecraftlauncherdb-9c9ab.firebaseapp.com",
  projectId: "minecraftlauncherdb-9c9ab",
  storageBucket: "minecraftlauncherdb-9c9ab.firebasestorage.app",
  messagingSenderId: "45230795917",
  appId: "1:45230795917:web:d70668d787caf3dbf106c4"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const bot = new TeleBot(BOT_TOKEN, { polling: true });

// ── Состояния ─────────────────────────────────────────────────────────
const sessions = {};
const connected = {};
const screenshotWatchers = {};

// ── Wake-on-LAN ───────────────────────────────────────────────────────
function sendMagicPacket(mac) {
  return new Promise((resolve, reject) => {
    const macHex = mac.replace(/[:\-]/g, '');
    if (macHex.length !== 12) { reject(new Error('Неверный MAC')); return; }

    const buf = Buffer.alloc(102);
    // 6 байт FF
    for (let i = 0; i < 6; i++) buf[i] = 0xff;
    // MAC повторяется 16 раз
    for (let i = 1; i <= 16; i++) {
      for (let j = 0; j < 6; j++) {
        buf[i * 6 + j] = parseInt(macHex.substring(j * 2, j * 2 + 2), 16);
      }
    }

    const socket = dgram.createSocket('udp4');
    socket.once('listening', () => socket.setBroadcast(true));
    socket.send(buf, 0, buf.length, 9, '255.255.255.255', (err) => {
      socket.close();
      if (err) reject(err); else resolve();
    });
  });
}

// ── Клавиатуры ────────────────────────────────────────────────────────
function mainKeyboard(isOnlineNow) {
  if (isOnlineNow) {
    return {
      reply_markup: {
        keyboard: [
          ["📊 Статус системы", "📸 Скриншот"],
          ["⏹ Выключить", "↺ Перезагрузить"],
          ["🔒 Заблокировать", "❌ Отмена выключения"],
          ["🔌 Отключиться"]
        ],
        resize_keyboard: true
      }
    };
  } else {
    return {
      reply_markup: {
        keyboard: [
          ["⚡ Включить ПК (WoL)"],
          ["📊 Статус", "🔌 Отключиться"]
        ],
        resize_keyboard: true
      }
    };
  }
}

function connectKeyboard() {
  return {
    reply_markup: {
      keyboard: [["🔗 Подключить компьютер"]],
      resize_keyboard: true
    }
  };
}

// ── Хелперы ───────────────────────────────────────────────────────────
async function getPcDoc(code) {
  const ref = doc(db, "pclink", code);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

async function sendCommand(code, command) {
  const ref = doc(db, "pclink", code);
  await updateDoc(ref, { pendingCommand: command });
}

function isOnline(data) {
  if (!data || data.status !== "online") return false;
  if (!data.lastSeen) return false;
  const lastSeen = data.lastSeen.toDate ? data.lastSeen.toDate() : new Date(data.lastSeen);
  return (Date.now() - lastSeen.getTime()) < 20000;
}

// ── Команды ───────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    "👋 Привет! Это PCLink — управление компьютером через Telegram.\n\nНажми кнопку чтобы подключить свой ПК:",
    connectKeyboard()
  );
});

bot.onText(/\/connect/, (msg) => startConnect(msg.chat.id));

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  const session = sessions[chatId];
  const code = connected[chatId];

  // ── Ожидаем код ──
  if (session?.step === "waiting_code") {
    const inputCode = text.trim().toUpperCase();
    sessions[chatId] = null;

    const data = await getPcDoc(inputCode);
    if (!data) {
      bot.sendMessage(chatId, "❌ Компьютер с таким кодом не найден.\nПроверь код и попробуй снова.", connectKeyboard());
      return;
    }

    connected[chatId] = inputCode;
    const online = isOnline(data);
    const ref = doc(db, "pclink", inputCode);
    await updateDoc(ref, { connectedChatId: chatId, connected: true });

    bot.sendMessage(chatId,
      `✅ Подключение удачное!\n\n🖥 Компьютер: ${data.hostname || inputCode}\nСтатус: ${online ? "🟢 онлайн" : "🔴 офлайн"}`,
      mainKeyboard(online)
    );
    return;
  }

  if (text === "🔗 Подключить компьютер") { startConnect(chatId); return; }

  if (text === "🔌 Отключиться") {
    if (code) {
      const ref = doc(db, "pclink", code);
      await updateDoc(ref, { connected: false, connectedChatId: null });
      delete connected[chatId];
    }
    bot.sendMessage(chatId, "🔌 Отключено.", connectKeyboard());
    return;
  }

  if (!code) {
    bot.sendMessage(chatId, "Сначала подключи компьютер:", connectKeyboard());
    return;
  }

  const data = await getPcDoc(code);

  // ── Включить через WoL ──
  if (text === "⚡ Включить ПК (WoL)") {
    if (!data?.mac) {
      bot.sendMessage(chatId, "❌ MAC-адрес не найден.\nУбедись что PCLink агент хотя бы раз запускался на этом ПК.", mainKeyboard(false));
      return;
    }
    try {
      await sendMagicPacket(data.mac);
      bot.sendMessage(chatId,
        `⚡ Магический пакет отправлен!\n\nMAC: \`${data.mac}\`\n\nПК должен включиться через 10–30 секунд.\nУбедись что Wake-on-LAN включён в BIOS.`,
        { parse_mode: "Markdown", ...mainKeyboard(false) }
      );
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка отправки WoL пакета: " + e.message, mainKeyboard(false));
    }
    return;
  }

  // Для остальных команд нужен онлайн
  if (!isOnline(data)) {
    bot.sendMessage(chatId,
      "⚠️ Компьютер офлайн.\n\nМожешь попробовать включить его:",
      mainKeyboard(false)
    );
    return;
  }

  switch (text) {
    case "📊 Статус системы":
    case "📊 Статус":
      bot.sendMessage(chatId,
        `🖥 *${data.hostname || code}*\n\n` +
        `CPU: ${data.cpu ?? "—"}%\n` +
        `RAM: ${data.ram ?? "—"}% (${data.ramUsed ?? "?"}/${data.ramTotal ?? "?"}GB)\n` +
        `Платформа: ${data.platform || "—"}\n` +
        `MAC: \`${data.mac || "—"}\`\n` +
        `Статус: 🟢 онлайн`,
        { parse_mode: "Markdown", ...mainKeyboard(true) }
      );
      break;

    case "📸 Скриншот": {
      bot.sendMessage(chatId, "📸 Делаю скриншот...");
      await sendCommand(code, "screenshot");
      if (screenshotWatchers[chatId]) screenshotWatchers[chatId]();
      const watchRef = doc(db, "pclink", code);
      screenshotWatchers[chatId] = onSnapshot(watchRef, (snap) => {
        const d = snap.data();
        if (!d?.lastScreenshot || d.lastScreenshot === "pending") return;
        screenshotWatchers[chatId]();
        delete screenshotWatchers[chatId];
        if (d.lastScreenshot === "error") {
          bot.sendMessage(chatId, "❌ Не удалось сделать скриншот.\nУбедись что nircmd.exe есть рядом с агентом.");
        } else {
          bot.sendPhoto(chatId, d.lastScreenshot, { caption: "📸 Скриншот экрана" });
        }
        updateDoc(watchRef, { lastScreenshot: null });
      });
      break;
    }

    case "⏹ Выключить":
      await sendCommand(code, "shutdown");
      bot.sendMessage(chatId, "⏹ Выключение через 10 секунд.\n\nНажми ❌ Отмена выключения чтобы остановить.", mainKeyboard(true));
      break;

    case "↺ Перезагрузить":
      await sendCommand(code, "restart");
      bot.sendMessage(chatId, "↺ Перезагрузка через 10 секунд.", mainKeyboard(true));
      break;

    case "🔒 Заблокировать":
      await sendCommand(code, "lock");
      bot.sendMessage(chatId, "🔒 Экран заблокирован.", mainKeyboard(true));
      break;

    case "❌ Отмена выключения":
      await sendCommand(code, "cancel");
      bot.sendMessage(chatId, "✅ Выключение отменено.", mainKeyboard(true));
      break;
  }
});

function startConnect(chatId) {
  sessions[chatId] = { step: "waiting_code" };
  bot.sendMessage(chatId,
    "🔗 Подключение компьютера\n\n" +
    "1. Запусти PCLink на своём ПК\n" +
    "2. Введи код который показан на экране:",
    { reply_markup: { remove_keyboard: true } }
  );
}

console.log("🤖 PCLink бот запущен!");