const TelegramBot = require("node-telegram-bot-api");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TOKEN         = process.env.TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── WORK RULES ────────────────────────────────────────────────────────────
const WORK_START_HOUR = 21;
const WORK_START_MIN  = 0;

// ─── DAILY REPORT TIME (10:30 AM) ──────────────────────────────────────────
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
      mention: "",
      wasLate: false,
      lateMinutes: 0,
      overtimeEvents: [],
    };
  }
  return sessions[userId];
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function now() { return new Date(); }

function formatTime(date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

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

function isLate() {
  const t = now();
  const ws = new Date(t);
  ws.setHours(WORK_START_HOUR, WORK_START_MIN, 0, 0);
  return t > ws;
}

function getMinutesLate() {
  const t = now();
  const ws = new Date(t);
  ws.setHours(WORK_START_HOUR, WORK_START_MIN, 0, 0);
  return Math.floor((t - ws) / 60000);
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
function startAwayTimer(userId, chatId, statusKey) {
  const session = getSession(userId);
  const limit   = AWAY_LIMITS[statusKey];
  if (!limit) return;
  if (session.awayTimer) clearTimeout(session.awayTimer);

  session.awayTimer = setTimeout(() => {
    const awayMs     = now() - session.awayStart;
    const limitLabel = formatDuration(limit);
    const awayLabel  = formatDuration(awayMs);

    // Save overtime event for daily report
    session.overtimeEvents.push({
      type: statusKey,
      duration: awayMs,
      limit: limit,
      time: now(),
    });

    send(chatId,
      `⚠️ *Overtime Alert!*\n\n` +
      `${session.mention} has been on *${STATUS_LABELS[statusKey]}* for *${awayLabel}*\n` +
      `Limit is ${limitLabel}. Please return to your seat!`
    );

    sendAdmin(
      `🚨 *OVERTIME ALERT*\n\n` +
      `👤 Staff: ${session.name}\n` +
      `📍 Status: ${STATUS_LABELS[statusKey]}\n` +
      `⏱ Away for: ${awayLabel} (limit: ${limitLabel})\n` +
      `🕐 Time: ${formatTime(now())}`
    );
  }, limit);
}

// ─── DAILY REPORT ──────────────────────────────────────────────────────────
function generateDailyReport() {
  const t         = now();
  const staffList = Object.entries(sessions);

  if (staffList.length === 0) {
    return `📊 *DAILY REPORT — ${t.toLocaleDateString()}*\n\nNo staff records today.`;
  }

  let lateStaff      = [];
  let overtimeStaff  = [];
  let noCheckinStaff = [];
  let fullLog        = [];

  staffList.forEach(([uid, s]) => {
    if (!s.name) return;

    // Did not clock in
    if (!s.workStart) {
      noCheckinStaff.push(s.name);
      return;
    }

    const totalMs       = t - s.workStart;
    const currentAwayMs = s.awayStart ? (t - s.awayStart) : 0;
    const workMs        = totalMs - s.totalAwayMs - currentAwayMs;

    // Late
    if (s.wasLate) {
      lateStaff.push(`• *${s.name}* — late by ${s.lateMinutes} min`);
    }

    // Overtime events
    if (s.overtimeEvents.length > 0) {
      s.overtimeEvents.forEach(ev => {
        overtimeStaff.push(
          `• *${s.name}* — ${STATUS_LABELS[ev.type]} overtime by ${formatDuration(ev.duration - ev.limit)}`
        );
      });
    }

    // Full log entry
    let entry = `👤 *${s.name}*\n`;
    entry += `📍 Status: ${STATUS_LABELS[s.status]}\n`;
    if (s.workStart) {
      entry += `⏰ Clock-in: ${formatTime(s.workStart)}\n`;
    }
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) entry += `🚪 Clock-out: ${formatTime(offEntry.time)}\n`;
    }
    entry += `💼 Work time: ${formatDuration(workMs)}\n`;
    entry += `🚶 Away time: ${formatDuration(s.totalAwayMs + currentAwayMs)}\n`;
    if (s.wasLate) entry += `⚠️ Late: ${s.lateMinutes} min\n`;
    if (s.overtimeEvents.length > 0) entry += `🚨 Overtime events: ${s.overtimeEvents.length}\n`;
    fullLog.push(entry);
  });

  let report = `📊 *DAILY REPORT*\n📅 ${t.toLocaleDateString()}\n🕐 Generated: ${formatTime(t)}\n`;
  report += `${"─".repeat(25)}\n\n`;

  // Late section
  if (lateStaff.length > 0) {
    report += `🚨 *LATE ARRIVALS (${lateStaff.length})*\n`;
    report += lateStaff.join("\n") + "\n\n";
  } else {
    report += `✅ *No late arrivals today!*\n\n`;
  }

  // Overtime section
  if (overtimeStaff.length > 0) {
    report += `⏱ *OVERTIME EVENTS (${overtimeStaff.length})*\n`;
    report += overtimeStaff.join("\n") + "\n\n";
  } else {
    report += `✅ *No overtime events today!*\n\n`;
  }

  // No check-in section
  if (noCheckinStaff.length > 0) {
    report += `❌ *DID NOT CLOCK IN (${noCheckinStaff.length})*\n`;
    report += noCheckinStaff.map(n => `• ${n}`).join("\n") + "\n\n";
  }

  // Full staff log
  report += `${"─".repeat(25)}\n📋 *FULL STAFF LOG*\n\n`;
  report += fullLog.join("\n");

  return report;
}

function resetDailySessions() {
  Object.keys(sessions).forEach(uid => {
    sessions[uid].status        = "idle";
    sessions[uid].workStart     = null;
    sessions[uid].awayStart     = null;
    sessions[uid].awayType      = null;
    sessions[uid].awayTimer     = null;
    sessions[uid].totalAwayMs   = 0;
    sessions[uid].log           = [];
    sessions[uid].wasLate       = false;
    sessions[uid].lateMinutes   = 0;
    sessions[uid].overtimeEvents = [];
  });
}

// ─── AUTO DAILY REPORT SCHEDULER ───────────────────────────────────────────
function scheduleDailyReport() {
  const t       = now();
  const next    = new Date(t);
  next.setHours(REPORT_HOUR, REPORT_MIN, 0, 0);

  // If time already passed today, schedule for tomorrow
  if (next <= t) next.setDate(next.getDate() + 1);

  const msUntil = next - t;
  const hUntil  = Math.floor(msUntil / 3600000);
  const mUntil  = Math.floor((msUntil % 3600000) / 60000);

  console.log(`📅 Daily report scheduled in ${hUntil}h ${mUntil}m`);

  setTimeout(() => {
    const report = generateDailyReport();
    sendAdmin(report);
    console.log("📊 Daily report sent to admin!");

    // Reset sessions after report
    setTimeout(() => {
      resetDailySessions();
      console.log("🔄 Sessions reset for new day.");
    }, 5000);

    // Schedule next report
    scheduleDailyReport();
  }, msUntil);
}

// Start the scheduler
scheduleDailyReport();

// ─── /start ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const session   = getSession(msg.from.id);
  session.name    = msg.from.first_name + (msg.from.last_name ? " " + msg.from.last_name : "");
  session.mention = getMention(msg);
  const name      = msg.from.first_name || "朋友";
  bot.sendMessage(msg.chat.id,
    `👋 你好 ${name}！\n\n请直接点击按钮打卡\nPlease tap a button to check in.\n\nStatus: ${STATUS_LABELS[session.status]}`,
    { reply_markup: getMainKeyboard() }
  );
});

// ─── /adminlog ─────────────────────────────────────────────────────────────
bot.onText(/\/adminlog/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "❌ You are not authorized.");
  }
  const report = generateDailyReport();
  bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
});

// ─── /adminstatus ──────────────────────────────────────────────────────────
bot.onText(/\/adminstatus/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "❌ You are not authorized.");
  }
  const staffList = Object.entries(sessions);
  if (staffList.length === 0) {
    return bot.sendMessage(msg.chat.id, "📋 No staff online yet.");
  }
  let report = `👥 *CURRENT STAFF STATUS*\n\n`;
  staffList.forEach(([uid, s]) => {
    if (s.name) report += `• *${s.name}* → ${STATUS_LABELS[s.status]}\n`;
  });
  bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
});

// ─── MESSAGES ──────────────────────────────────────────────────────────────
bot.on("message", (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const text    = msg.text;
  const session = getSession(userId);
  const t       = now();

  if (!session.name) {
    session.name    = msg.from.first_name + (msg.from.last_name ? " " + msg.from.last_name : "");
    session.mention = getMention(msg);
  }

  if (!text || text.startsWith("/")) return;

  // ── START WORK ───────────────────────────────────────────────────────────
  if (text.includes("Start Work") || text.includes("上班")) {
    if (session.status !== "idle" && session.status !== "off") {
      return send(chatId, `⚠️ ${session.mention} 你已经上班了！\nYou already clocked in.`);
    }
    session.status      = "work";
    session.workStart   = t;
    session.totalAwayMs = 0;
    session.log         = [{ action: "上班 Start Work", time: t }];

    let msg2 =
      `✅ *上班打卡成功！*\n` +
      `👤 ${session.mention}\n` +
      `⏰ Clock-in: ${formatTime(t)}\n\n` +
      `Status: ${STATUS_LABELS["work"]}`;

    if (isLate()) {
      const minsLate      = getMinutesLate();
      session.wasLate     = true;
      session.lateMinutes = minsLate;
      msg2 += `\n\n⚠️ 迟到 *${minsLate}* 分钟！/ Late by *${minsLate}* minute(s)!`;
      sendAdmin(
        `🚨 *LATE ARRIVAL*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `⏰ Clocked in at: ${formatTime(t)}\n` +
        `📌 Should start at: 9:00 PM\n` +
        `⏱ Late by: ${minsLate} minute(s)`
      );
    }

    send(chatId, msg2, true);
  }

  // ── OFF WORK ─────────────────────────────────────────────────────────────
  else if (text.includes("Off Work") || text.includes("下班")) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${session.mention} 你还没上班呢！\nYou haven't clocked in yet.`);
    }
    if (session.awayTimer) { clearTimeout(session.awayTimer); session.awayTimer = null; }
    if (session.awayStart) { session.totalAwayMs += t - session.awayStart; session.awayStart = null; }

    session.log.push({ action: "下班 Off Work", time: t });
    const totalMs  = t - session.workStart;
    const workMs   = totalMs - session.totalAwayMs;
    session.status = "off";

    send(chatId,
      `🔴 *下班打卡！*\n` +
      `👤 ${session.mention}\n` +
      `⏰ Clock-out: ${formatTime(t)}\n` +
      `🕐 Total: ${formatDuration(totalMs)}\n` +
      `💼 Work: ${formatDuration(workMs)}\n` +
      `🚶 Away: ${formatDuration(session.totalAwayMs)}`,
      true
    );

    sendAdmin(
      `📋 *CLOCKED OUT*\n\n` +
      `👤 Staff: ${session.name}\n` +
      `⏰ Clock-out: ${formatTime(t)}\n` +
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
      return send(chatId, `⚠️ ${session.mention} 请先上班打卡！\nPlease clock in first.`);
    }
    if (["eat", "toilet", "smoke", "other"].includes(session.status)) {
      return send(chatId, `⚠️ ${session.mention} 你已经在: ${STATUS_LABELS[session.status]}`);
    }

    let statusKey = "other"; let emoji = "🔵";
    if (text.includes("Eat")    || text.includes("吃饭")) { statusKey = "eat";    emoji = "🍜"; }
    if (text.includes("Toilet") || text.includes("厕所")) { statusKey = "toilet"; emoji = "🚻"; }
    if (text.includes("Smoke")  || text.includes("抽烟")) { statusKey = "smoke";  emoji = "🚬"; }

    session.status    = statusKey;
    session.awayStart = t;
    session.awayType  = statusKey;
    session.log.push({ action: text.trim(), time: t });

    send(chatId,
      `${emoji} ${session.mention} → *${STATUS_LABELS[statusKey]}*\n` +
      `Time: ${formatTime(t)}\n` +
      `⏱ Limit: ${formatDuration(AWAY_LIMITS[statusKey])}`,
      true
    );

    startAwayTimer(userId, chatId, statusKey);
  }

  // ── BACK TO SEAT ─────────────────────────────────────────────────────────
  else if (text.includes("Back to Seat") || text.includes("回座")) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${session.mention} 请先上班打卡！\nPlease clock in first.`);
    }
    if (session.status === "work") {
      return send(chatId, `✅ ${session.mention} 你已经在座位上了！\nYou're already at your seat!`);
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
    session.log.push({ action: "回座 Back to Seat", time: t });

    let msg2 =
      `💺 ${session.mention} *回座！/ Back to seat!*\n` +
      `Time: ${formatTime(t)}\n` +
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
console.log("✅ Work Check-in Bot is running...");
console.log(`📅 Daily report will be sent at ${REPORT_HOUR}:${String(REPORT_MIN).padStart(2,"0")} AM`);