const TeleBot = require("node-telegram-bot-api");
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot } = require("firebase/firestore");
const express = require("express");
const dgram = require("dgram");

const app = express();
app.get("/", (req, res) => res.send("PCLink bot is running"));
app.listen(process.env.PORT || 3000, () => console.log("HTTP server started"));

const BOT_TOKEN = "8653027213:AAH7ALHxrzZtQdTrfT_EhmaGxS9EJFgxDnM";

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

const sessions = {};
const screenshotWatchers = {};

// ── Firestore сессии ──────────────────────────────────────────────────
async function getConnectedCode(chatId) {
  try {
    const snap = await getDoc(doc(db, "pclink_sessions", String(chatId)));
    return snap.exists() ? snap.data().code || null : null;
  } catch { return null; }
}
async function saveConnectedCode(chatId, code) {
  await setDoc(doc(db, "pclink_sessions", String(chatId)), { code, chatId: String(chatId), updatedAt: Date.now() });
}
async function removeConnectedCode(chatId) {
  await setDoc(doc(db, "pclink_sessions", String(chatId)), { code: null, chatId: String(chatId), updatedAt: Date.now() });
}

// ── Wake-on-LAN ───────────────────────────────────────────────────────
// Шлём на внешний IP из Firestore (агент сохраняет его при запуске)
// Роутер должен пробрасывать UDP 9 на локальный ПК
function sendMagicPacket(mac, targetIP) {
  return new Promise((resolve, reject) => {
    const macHex = mac.replace(/[:\-]/g, '');
    if (macHex.length !== 12) { reject(new Error('Неверный MAC')); return; }
    const buf = Buffer.alloc(102);
    for (let i = 0; i < 6; i++) buf[i] = 0xff;
    for (let i = 1; i <= 16; i++)
      for (let j = 0; j < 6; j++)
        buf[i * 6 + j] = parseInt(macHex.substring(j * 2, j * 2 + 2), 16);
    const socket = dgram.createSocket('udp4');
    socket.once('listening', () => socket.setBroadcast(true));
    // Если есть внешний IP — шлём туда, иначе broadcast
    const target = targetIP || '255.255.255.255';
    socket.send(buf, 0, buf.length, 9, target, (err) => {
      socket.close();
      if (err) reject(err); else resolve();
    });
  });
}

// ── Клавиатуры ────────────────────────────────────────────────────────
function mainKeyboard(online = true) {
  if (online) {
    return {
      reply_markup: {
        keyboard: [
          ["Статус", "Скриншот"],
          ["Выключить", "Перезагрузить"],
          ["Заблокировать", "Отмена выключения"],
          ["Отключиться"]
        ],
        resize_keyboard: true
      }
    };
  } else {
    return {
      reply_markup: {
        keyboard: [
          ["Включить ПК (WoL)"],
          ["Статус", "Отключиться"]
        ],
        resize_keyboard: true
      }
    };
  }
}

function connectKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Подключить компьютер"]],
      resize_keyboard: true
    }
  };
}

// ── Хелперы ───────────────────────────────────────────────────────────
async function getPcDoc(code) {
  const snap = await getDoc(doc(db, "pclink", code));
  return snap.exists() ? snap.data() : null;
}
async function sendCommand(code, command) {
  await updateDoc(doc(db, "pclink", code), { pendingCommand: command });
}
function isOnline(data) {
  if (!data || data.status !== "online" || !data.lastSeen) return false;
  const lastSeen = data.lastSeen.toDate ? data.lastSeen.toDate() : new Date(data.lastSeen);
  return (Date.now() - lastSeen.getTime()) < 25000;
}

// ── Проверка разрешений ───────────────────────────────────────────────
function isAllowed(data, key) {
  const val = data['allow_' + key];
  // Если не задано — разрешено по умолчанию (кроме lock)
  if (val === undefined) return key !== 'lock';
  return val === true;
}

// ── Хендлеры ─────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "PCLink — удалённое управление компьютером.\n\nПодключи свой ПК чтобы начать.",
    connectKeyboard()
  );
});

bot.onText(/\/connect/, (msg) => startConnect(msg.chat.id));

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  const session = sessions[chatId];

  if (session?.step === "waiting_code") {
    const inputCode = text.trim().toUpperCase();
    sessions[chatId] = null;
    const data = await getPcDoc(inputCode);
    if (!data) {
      bot.sendMessage(chatId, "Компьютер с таким кодом не найден. Проверь код и попробуй снова.", connectKeyboard());
      return;
    }
    await saveConnectedCode(chatId, inputCode);
    await updateDoc(doc(db, "pclink", inputCode), { connectedChatId: String(chatId), connected: true });
    const online = isOnline(data);
    bot.sendMessage(chatId,
      `Подключено.\n\nКомпьютер: ${data.hostname || inputCode}\nСтатус: ${online ? "онлайн" : "офлайн"}`,
      mainKeyboard(online)
    );
    return;
  }

  if (text === "Подключить компьютер") { startConnect(chatId); return; }

  const code = await getConnectedCode(chatId);

  if (text === "Отключиться") {
    if (code) {
      await updateDoc(doc(db, "pclink", code), { connected: false, connectedChatId: null });
      await removeConnectedCode(chatId);
    }
    bot.sendMessage(chatId, "Отключено.", connectKeyboard());
    return;
  }

  if (!code) {
    bot.sendMessage(chatId, "Сначала подключи компьютер.", connectKeyboard());
    return;
  }

  const data = await getPcDoc(code);
  const online = isOnline(data);

  if (text === "Включить ПК (WoL)") {
    if (!data?.mac) {
      bot.sendMessage(chatId, "MAC-адрес не найден. Агент должен хотя бы раз запуститься на этом ПК.", mainKeyboard(false));
      return;
    }
    try {
      const targetIP = data.externalIP || null;
      await sendMagicPacket(data.mac, targetIP);
      bot.sendMessage(chatId,
        `Пакет отправлен.\n\nMAC: \`${data.mac}\`\nIP: \`${targetIP || 'broadcast'}\`\n\nПК должен включиться через 10-30 секунд.\nТребуется:\n— WoL включён в BIOS\n— UDP порт 9 проброшен на роутере`,
        { parse_mode: "Markdown", ...mainKeyboard(false) }
      );
    } catch (e) {
      bot.sendMessage(chatId, "Ошибка отправки пакета: " + e.message, mainKeyboard(false));
    }
    return;
  }

  if (!online) {
    bot.sendMessage(chatId, "Компьютер офлайн.", mainKeyboard(false));
    return;
  }

  switch (text) {
    case "Статус":
      if (!isAllowed(data, 'status')) { bot.sendMessage(chatId, "Команда отключена владельцем ПК.", mainKeyboard(true)); break; }
      bot.sendMessage(chatId,
        `*${data.hostname || code}*\n\n` +
        `CPU: ${data.cpu ?? "—"}%\n` +
        `RAM: ${data.ram ?? "—"}% (${data.ramUsed ?? "?"}/${data.ramTotal ?? "?"} GB)\n` +
        `IP: \`${data.externalIP || "—"}\`\n` +
        `MAC: \`${data.mac || "—"}\`\n` +
        `Статус: онлайн`,
        { parse_mode: "Markdown", ...mainKeyboard(true) }
      );
      break;

    case "Скриншот": {
      if (!isAllowed(data, 'screenshot')) { bot.sendMessage(chatId, "Команда отключена владельцем ПК.", mainKeyboard(true)); break; }
      bot.sendMessage(chatId, "Делаю скриншот...");
      await sendCommand(code, "screenshot");
      if (screenshotWatchers[chatId]) screenshotWatchers[chatId]();
      const watchRef = doc(db, "pclink", code);
      screenshotWatchers[chatId] = onSnapshot(watchRef, (snap) => {
        const d = snap.data();
        if (!d?.lastScreenshot || d.lastScreenshot === "pending") return;
        screenshotWatchers[chatId]();
        delete screenshotWatchers[chatId];
        if (d.lastScreenshot === "error") {
          bot.sendMessage(chatId, "Не удалось сделать скриншот. Убедись что nircmd.exe лежит рядом с агентом.");
        } else {
          bot.sendPhoto(chatId, d.lastScreenshot, { caption: "Скриншот экрана" });
        }
        updateDoc(watchRef, { lastScreenshot: null });
      });
      break;
    }

    case "Выключить":
      if (!isAllowed(data, 'shutdown')) { bot.sendMessage(chatId, "Команда отключена владельцем ПК.", mainKeyboard(true)); break; }
      await sendCommand(code, "shutdown");
      bot.sendMessage(chatId, "Выключение через 10 секунд. Нажми «Отмена выключения» чтобы остановить.", mainKeyboard(true));
      break;

    case "Перезагрузить":
      if (!isAllowed(data, 'restart')) { bot.sendMessage(chatId, "Команда отключена владельцем ПК.", mainKeyboard(true)); break; }
      await sendCommand(code, "restart");
      bot.sendMessage(chatId, "Перезагрузка через 10 секунд.", mainKeyboard(true));
      break;

    case "Заблокировать":
      if (!isAllowed(data, 'lock')) { bot.sendMessage(chatId, "Команда отключена владельцем ПК.", mainKeyboard(true)); break; }
      await sendCommand(code, "lock");
      bot.sendMessage(chatId, "Экран заблокирован.", mainKeyboard(true));
      break;

    case "Отмена выключения":
      await sendCommand(code, "cancel");
      bot.sendMessage(chatId, "Выключение отменено.", mainKeyboard(true));
      break;
  }
});

function startConnect(chatId) {
  sessions[chatId] = { step: "waiting_code" };
  bot.sendMessage(chatId,
    "Подключение компьютера.\n\n1. Запусти PCLink на своём ПК\n2. Введи код который показан на экране:",
    { reply_markup: { remove_keyboard: true } }
  );
}

console.log("PCLink bot started");
