const TelegramBot = require("node-telegram-bot-api");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TOKEN         = process.env.TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── TIMEZONE (Cambodia GMT+7) ─────────────────────────────────────────────
const TIMEZONE_OFFSET = 7 * 60 * 60 * 1000;

function nowCambodia() {
  return new Date(Date.now() + TIMEZONE_OFFSET);
}

function formatTime(date) {
  return date.toISOString().slice(11, 16).replace("T", " ");
}

function formatTimeCambodia(date) {
  const cam = new Date(date.getTime() + TIMEZONE_OFFSET);
  return cam.toISOString().slice(11, 16);
}

// ─── WORK RULES ────────────────────────────────────────────────────────────
const WORK_START_HOUR = 21; // 9:00 PM Cambodia time
const WORK_START_MIN  = 0;

// ─── DAILY REPORT TIME (10:30 AM Cambodia) ─────────────────────────────────
const REPORT_HOUR = 10;
const REPORT_MIN  = 30;

const AWAY_LIMITS = {
  eat:    30 * 60 * 1000,
  toilet: 15 * 60 * 1000,
  smoke:   5 * 60 * 1000,
  other:  30 * 60 * 1000,
};

// ─── STATE ─────────────────────────────────────────────────────────────────
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      status: "idle",
      workStart: null,
      awayStart: null,
      awayType: null,
      awayTimer: null,
      totalAwayMs: 0,
      log: [],
      name: "",
      wasLate: false,
      lateMinutes: 0,
      overtimeEvents: [],
    };
  }
  return sessions[userId];
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getMention(msg) {
  if (msg.from.username) return `@${msg.from.username}`;
  return `[${msg.from.first_name || "Staff"}](tg://user?id=${msg.from.id})`;
}

function getName(msg) {
  return (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : "") || "Staff";
}

function sendAdmin(message) {
  if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== "YOUR_ADMIN_CHAT_ID") {
    bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: "Markdown" }).catch(() => {});
  }
}

function send(chatId, message, withKeyboard) {
  const opts = { parse_mode: "Markdown" };
  if (withKeyboard) opts.reply_markup = getMainKeyboard();
  bot.sendMessage(chatId, message, opts).catch(() => {});
}

// ─── LATE CHECK (Cambodia time) ────────────────────────────────────────────
function isLate() {
  const cam = nowCambodia();
  const h   = parseInt(cam.toISOString().slice(11, 13));
  const m   = parseInt(cam.toISOString().slice(14, 16));
  const totalMins     = h * 60 + m;
  const workStartMins = WORK_START_HOUR * 60 + WORK_START_MIN;
  return totalMins > workStartMins;
}

function getMinutesLate() {
  const cam = nowCambodia();
  const h   = parseInt(cam.toISOString().slice(11, 13));
  const m   = parseInt(cam.toISOString().slice(14, 16));
  const totalMins     = h * 60 + m;
  const workStartMins = WORK_START_HOUR * 60 + WORK_START_MIN;
  return totalMins - workStartMins;
}

function getCurrentCambodiaTime() {
  const cam = nowCambodia();
  return cam.toISOString().slice(11, 16);
}

function isAdmin(userId) {
  return String(userId) === String(ADMIN_CHAT_ID);
}

// ─── KEYBOARD ──────────────────────────────────────────────────────────────
function getMainKeyboard() {
  return {
    keyboard: [
      [{ text: "上班 / Start Work" }, { text: "下班 / Off Work" }],
      [{ text: "吃饭 / Eat" }, { text: "上厕所 / Toilet" }, { text: "抽烟 / Smoke" }],
      [{ text: "其他 / Other" }],
      [{ text: "回座 / Back to Seat" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ─── STATUS LABELS ─────────────────────────────────────────────────────────
const STATUS_LABELS = {
  work:   "🟢 上班中 / Working",
  eat:    "🍜 吃饭中 / Eating",
  toilet: "🚻 上厕所 / Toilet",
  smoke:  "🚬 抽烟 / Smoking",
  other:  "🔵 其他 / Other",
  off:    "🔴 已下班 / Off Work",
  idle:   "⬜ 未上班 / Not Started",
};

// ─── AWAY TIMER ────────────────────────────────────────────────────────────
function startAwayTimer(userId, chatId, statusKey, mention, name) {
  const session = getSession(userId);
  const limit   = AWAY_LIMITS[statusKey];
  if (!limit) return;
  if (session.awayTimer) clearTimeout(session.awayTimer);

  session.awayTimer = setTimeout(() => {
    const awayMs     = Date.now() - session.awayStart;
    const limitLabel = formatDuration(limit);
    const awayLabel  = formatDuration(awayMs);

    session.overtimeEvents.push({ type: statusKey, duration: awayMs, limit, time: Date.now() });

    send(chatId,
      `⚠️ *Overtime Alert!*\n\n` +
      `${mention} has been on *${STATUS_LABELS[statusKey]}* for *${awayLabel}*\n` +
      `Limit is ${limitLabel}. Please return to your seat!`
    );

    sendAdmin(
      `🚨 *OVERTIME ALERT*\n\n` +
      `👤 Staff: ${name}\n` +
      `📍 Status: ${STATUS_LABELS[statusKey]}\n` +
      `⏱ Away for: ${awayLabel} (limit: ${limitLabel})\n` +
      `🕐 Time: ${getCurrentCambodiaTime()} (Cambodia)`
    );
  }, limit);
}

// ─── DAILY REPORT ──────────────────────────────────────────────────────────
function generateDailyReport() {
  const now       = Date.now();
  const staffList = Object.entries(sessions);
  const camTime   = getCurrentCambodiaTime();

  if (staffList.length === 0) {
    return `📊 *DAILY REPORT*\n🕐 ${camTime} (Cambodia)\n\nNo staff records today.`;
  }

  let lateStaff     = [];
  let overtimeStaff = [];
  let fullLog       = [];

  staffList.forEach(([uid, s]) => {
    if (!s.name || !s.workStart) return;

    const totalMs       = now - s.workStart;
    const currentAwayMs = s.awayStart ? (now - s.awayStart) : 0;
    const workMs        = totalMs - s.totalAwayMs - currentAwayMs;

    if (s.wasLate) lateStaff.push(`• *${s.name}* — late by ${s.lateMinutes} min`);
    if (s.overtimeEvents.length > 0) {
      s.overtimeEvents.forEach(ev => {
        overtimeStaff.push(`• *${s.name}* — ${STATUS_LABELS[ev.type]} overtime by ${formatDuration(ev.duration - ev.limit)}`);
      });
    }

    let entry = `👤 *${s.name}*\n📍 ${STATUS_LABELS[s.status]}\n`;
    entry += `⏰ Clock-in: ${s.clockInTime || "?"}\n`;
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) entry += `🚪 Clock-out: ${offEntry.timeStr}\n`;
    }
    entry += `💼 Work: ${formatDuration(workMs)}\n🚶 Away: ${formatDuration(s.totalAwayMs + currentAwayMs)}\n`;
    if (s.wasLate) entry += `⚠️ Late: ${s.lateMinutes} min\n`;
    if (s.overtimeEvents.length > 0) entry += `🚨 Overtime: ${s.overtimeEvents.length} event(s)\n`;
    fullLog.push(entry);
  });

  let report = `📊 *DAILY REPORT*\n🕐 ${camTime} (Cambodia)\n${"─".repeat(20)}\n\n`;
  report += lateStaff.length > 0 ? `🚨 *LATE (${lateStaff.length})*\n${lateStaff.join("\n")}\n\n` : `✅ *No late arrivals!*\n\n`;
  report += overtimeStaff.length > 0 ? `⏱ *OVERTIME (${overtimeStaff.length})*\n${overtimeStaff.join("\n")}\n\n` : `✅ *No overtime!*\n\n`;
  report += `${"─".repeat(20)}\n📋 *FULL LOG*\n\n${fullLog.join("\n")}`;
  return report;
}

function resetDailySessions() {
  Object.keys(sessions).forEach(uid => {
    sessions[uid].status         = "idle";
    sessions[uid].workStart      = null;
    sessions[uid].awayStart      = null;
    sessions[uid].awayType       = null;
    sessions[uid].awayTimer      = null;
    sessions[uid].totalAwayMs    = 0;
    sessions[uid].log            = [];
    sessions[uid].wasLate        = false;
    sessions[uid].lateMinutes    = 0;
    sessions[uid].overtimeEvents = [];
    sessions[uid].clockInTime    = null;
  });
}

// ─── AUTO DAILY REPORT (10:30 AM Cambodia = 03:30 UTC) ─────────────────────
function scheduleDailyReport() {
  const nowUtc  = Date.now();
  const camNow  = new Date(nowUtc + TIMEZONE_OFFSET);
  const next    = new Date(camNow);
  next.setUTCHours(REPORT_HOUR - 7 < 0 ? REPORT_HOUR - 7 + 24 : REPORT_HOUR - 7);
  next.setUTCMinutes(REPORT_MIN);
  next.setUTCSeconds(0);
  next.setUTCMilliseconds(0);

  // Convert report time to UTC: 10:30 AM GMT+7 = 03:30 UTC
  const reportUTCHour = REPORT_HOUR - 7 < 0 ? REPORT_HOUR - 7 + 24 : REPORT_HOUR - 7;
  const nowDate = new Date();
  const nextReport = new Date();
  nextReport.setUTCHours(reportUTCHour, REPORT_MIN, 0, 0);
  if (nextReport <= nowDate) nextReport.setUTCDate(nextReport.getUTCDate() + 1);

  const msUntil = nextReport - nowDate;
  console.log(`📅 Daily report in ${Math.floor(msUntil/3600000)}h ${Math.floor((msUntil%3600000)/60000)}m (sends at 10:30 AM Cambodia)`);

  setTimeout(() => {
    sendAdmin(generateDailyReport());
    console.log("📊 Daily report sent!");
    setTimeout(() => { resetDailySessions(); console.log("🔄 Sessions reset."); }, 5000);
    scheduleDailyReport();
  }, msUntil);
}
scheduleDailyReport();

// ─── BLOCKED COMMANDS ──────────────────────────────────────────────────────
const BLOCKED_PATTERNS = [
  /\/timer/i, /\/schedule/i, /\/remind/i, /\/auto/i,
  /\/alarm/i, /set.?timer/i, /set.?reminder/i, /auto.?clock/i,
];

// ─── /start ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const session = getSession(msg.from.id);
  session.name  = getName(msg);
  bot.sendMessage(msg.chat.id,
    `👋 你好 ${msg.from.first_name || "朋友"}！\n\n请直接点击按钮打卡\nPlease tap a button to check in.\n\nStatus: ${STATUS_LABELS[session.status]}`,
    { reply_markup: getMainKeyboard() }
  );
});

// ─── /adminlog ─────────────────────────────────────────────────────────────
bot.onText(/\/adminlog/, (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");
  bot.sendMessage(msg.chat.id, generateDailyReport(), { parse_mode: "Markdown" });
});

// ─── /adminstatus ──────────────────────────────────────────────────────────
bot.onText(/\/adminstatus/, (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");
  const staffList = Object.entries(sessions);
  if (staffList.length === 0) return bot.sendMessage(msg.chat.id, "📋 No staff online yet.");
  let report = `👥 *CURRENT STAFF STATUS*\n🕐 ${getCurrentCambodiaTime()} (Cambodia)\n\n`;
  staffList.forEach(([uid, s]) => { if (s.name) report += `• *${s.name}* → ${STATUS_LABELS[s.status]}\n`; });
  bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
});

// ─── MESSAGES ──────────────────────────────────────────────────────────────
bot.on("message", (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const text    = msg.text;
  const session = getSession(userId);
  const t       = Date.now();

  session.name  = getName(msg);
  const mention = getMention(msg);
  const camTime = getCurrentCambodiaTime();

  if (!text) return;

  // ── BLOCK AUTO CLOCK-IN ──────────────────────────────────────────────────
  const isBlocked = BLOCKED_PATTERNS.some(p => p.test(text));
  if (isBlocked) {
    send(chatId,
      `🚫 *Auto clock-in is not allowed!*\n\n` +
      `${mention} You cannot set scheduled or automatic clock-ins.\n` +
      `Please tap the button manually.`
    );
    sendAdmin(
      `⚠️ *AUTO CLOCK-IN ATTEMPT*\n\n` +
      `👤 Staff: ${session.name}\n` +
      `💬 Message: ${text}\n` +
      `🕐 Time: ${camTime} (Cambodia)`
    );
    return;
  }

  if (text.startsWith("/")) return;

  // ── START WORK ───────────────────────────────────────────────────────────
  if (text.includes("Start Work") || text.includes("上班")) {
    if (session.status !== "idle" && session.status !== "off") {
      return send(chatId, `⚠️ ${mention} 你已经上班了！\nYou already clocked in.`);
    }

    session.status      = "work";
    session.workStart   = t;
    session.totalAwayMs = 0;
    session.clockInTime = camTime;
    session.log         = [{ action: "上班 Start Work", time: t, timeStr: camTime }];

    let msg2 =
      `✅ *上班打卡成功！*\n` +
      `👤 ${mention}\n` +
      `⏰ Clock-in: ${camTime} (Cambodia)\n\n` +
      `Status: ${STATUS_LABELS["work"]}`;

    if (isLate()) {
      const minsLate      = getMinutesLate();
      session.wasLate     = true;
      session.lateMinutes = minsLate;

      // Show late warning in GROUP
      msg2 += `\n\n🚨 *${mention} is LATE by ${minsLate} minute(s)!*\n⏰ Should clock in at 9:00 PM`;

      // Notify admin privately
      sendAdmin(
        `🚨 *LATE ARRIVAL*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `⏰ Clocked in: ${camTime} (Cambodia)\n` +
        `📌 Should start: 9:00 PM\n` +
        `⏱ Late by: *${minsLate} minute(s)*`
      );
    }

    send(chatId, msg2, true);
  }

  // ── OFF WORK ─────────────────────────────────────────────────────────────
  else if (text.includes("Off Work") || text.includes("下班")) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${mention} 你还没上班呢！\nYou haven't clocked in yet.`);
    }
    if (session.awayTimer) { clearTimeout(session.awayTimer); session.awayTimer = null; }
    if (session.awayStart) { session.totalAwayMs += t - session.awayStart; session.awayStart = null; }

    session.log.push({ action: "下班 Off Work", time: t, timeStr: camTime });
    const totalMs  = t - session.workStart;
    const workMs   = totalMs - session.totalAwayMs;
    session.status = "off";

    send(chatId,
      `🔴 *下班打卡！*\n` +
      `👤 ${mention}\n` +
      `⏰ Clock-out: ${camTime} (Cambodia)\n` +
      `🕐 Total: ${formatDuration(totalMs)}\n` +
      `💼 Work: ${formatDuration(workMs)}\n` +
      `🚶 Away: ${formatDuration(session.totalAwayMs)}`,
      true
    );

    sendAdmin(
      `📋 *CLOCKED OUT*\n\n` +
      `👤 Staff: ${session.name}\n` +
      `⏰ Clock-out: ${camTime} (Cambodia)\n` +
      `🕐 Total: ${formatDuration(totalMs)}\n` +
      `💼 Work: ${formatDuration(workMs)}\n` +
      `🚶 Away: ${formatDuration(session.totalAwayMs)}`
    );
  }

  // ── AWAY ACTIONS ─────────────────────────────────────────────────────────
  else if (
    text.includes("Eat")    || text.includes("吃饭") ||
    text.includes("Toilet") || text.includes("厕所") ||
    text.includes("Smoke")  || text.includes("抽烟") ||
    text.includes("Other")  || text.includes("其他")
  ) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${mention} 请先上班打卡！\nPlease clock in first.`);
    }
    if (["eat", "toilet", "smoke", "other"].includes(session.status)) {
      return send(chatId, `⚠️ ${mention} 你已经在: ${STATUS_LABELS[session.status]}`);
    }

    let statusKey = "other"; let emoji = "🔵";
    if (text.includes("Eat")    || text.includes("吃饭")) { statusKey = "eat";    emoji = "🍜"; }
    if (text.includes("Toilet") || text.includes("厕所")) { statusKey = "toilet"; emoji = "🚻"; }
    if (text.includes("Smoke")  || text.includes("抽烟")) { statusKey = "smoke";  emoji = "🚬"; }

    session.status    = statusKey;
    session.awayStart = t;
    session.awayType  = statusKey;
    session.log.push({ action: text.trim(), time: t, timeStr: camTime });

    send(chatId,
      `${emoji} ${mention} → *${STATUS_LABELS[statusKey]}*\n` +
      `Time: ${camTime} (Cambodia)\n` +
      `⏱ Limit: ${formatDuration(AWAY_LIMITS[statusKey])}`,
      true
    );

    startAwayTimer(userId, chatId, statusKey, mention, session.name);
  }

  // ── BACK TO SEAT ─────────────────────────────────────────────────────────
  else if (text.includes("Back to Seat") || text.includes("回座")) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${mention} 请先上班打卡！\nPlease clock in first.`);
    }
    if (session.status === "work") {
      return send(chatId, `✅ ${mention} 你已经在座位上了！\nYou're already at your seat!`);
    }
    if (session.awayTimer) { clearTimeout(session.awayTimer); session.awayTimer = null; }

    let awayDuration = 0;
    if (session.awayStart) {
      awayDuration = t - session.awayStart;
      session.totalAwayMs += awayDuration;
      session.awayStart = null;
    }

    const limitMs     = AWAY_LIMITS[session.awayType] || 0;
    const wasOvertime = awayDuration > limitMs;
    session.status    = "work";
    session.log.push({ action: "回座 Back to Seat", time: t, timeStr: camTime });

    let msg2 =
      `💺 ${mention} *回座！/ Back to seat!*\n` +
      `Time: ${camTime} (Cambodia)\n` +
      `Away: ${formatDuration(awayDuration)}`;

    if (wasOvertime) {
      const overMs = awayDuration - limitMs;
      msg2 += `\n⚠️ Overtime by *${formatDuration(overMs)}*!`;
    }
    send(chatId, msg2, true);
  }
});

// ─── ERRORS ────────────────────────────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err.message));
console.log("✅ Work Check-in Bot is running... (Cambodia GMT+7)");