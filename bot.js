const TelegramBot = require("node-telegram-bot-api");
const ExcelJS     = require("exceljs");
const fs          = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TOKEN         = process.env.TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── TIMEZONE ──────────────────────────────────────────────────────────────
const WORK_START_UTC_HOUR = 14; // 9:00 PM Cambodia = 14:00 UTC
const WORK_START_UTC_MIN  = 0;
const REPORT_UTC_HOUR     = 3;  // 10:30 AM Cambodia = 03:30 UTC
const REPORT_UTC_MIN      = 30;

// ─── BREAK LIMITS ──────────────────────────────────────────────────────────
// The displayed limit is the "soft" limit. Staff have a grace period until the
// NEXT full minute. e.g. Eat 30min → 30:00–30:59 is OK, alert fires at 31:00.
// We add 60 seconds to each so the overtime alert triggers at limit+1 minute.
const GRACE_MS = 60 * 1000; // 1 minute grace

const AWAY_LIMITS = {
  eat:    30 * 60 * 1000 + GRACE_MS,  // shows 30m, alert at 31m
  toilet: 15 * 60 * 1000 + GRACE_MS,  // shows 15m, alert at 16m
  smoke:   5 * 60 * 1000 + GRACE_MS,  // shows 5m,  alert at 6m
  other:   5 * 60 * 1000 + GRACE_MS,  // shows 5m,  alert at 6m
};

// Display limits (the number shown to staff, without the grace minute)
const DISPLAY_LIMITS = {
  eat:    30 * 60 * 1000,
  toilet: 15 * 60 * 1000,
  smoke:   5 * 60 * 1000,
  other:   5 * 60 * 1000,
};

// ─── STATE ─────────────────────────────────────────────────────────────────
const sessions = {};
let lastReportDate = "";

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
      clockInTime: null,
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

function nowCambodiaStr() {
  const cam = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const h = String(cam.getUTCHours()).padStart(2, "0");
  const m = String(cam.getUTCMinutes()).padStart(2, "0");
  const s = String(cam.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function nowCambodiaDateStr() {
  const cam = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return cam.toISOString().slice(0, 10);
}

// ── ALWAYS use the user's unique ID for mentions ───────────────────────────
// Using @username as plain text lets Telegram re-resolve it, which can ping
// the WRONG person if usernames change or conflict. A tg://user?id= link is
// tied to the unique account ID and can never point to the wrong person.
function getMention(msg) {
  const user = msg.from;
  const name = user.first_name || user.username || "Staff";
  // Escape Markdown special characters in the display name
  const safeName = name.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
  return `[${safeName}](tg://user?id=${user.id})`;
}

function getName(msg) {
  const user  = msg.from; // always the actual sender
  const first = user.first_name || "";
  const last  = user.last_name  || "";
  return (first + " " + last).trim() || "Staff";
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
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes()) > (WORK_START_UTC_HOUR * 60 + WORK_START_UTC_MIN);
}

function getMinutesLate() {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes()) - (WORK_START_UTC_HOUR * 60 + WORK_START_UTC_MIN);
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
  const limit   = AWAY_LIMITS[statusKey];           // grace limit (fires at +1min)
  const dispLimit = DISPLAY_LIMITS[statusKey];      // friendly number shown to staff
  if (!limit) return;
  if (session.awayTimer) clearTimeout(session.awayTimer);

  session.awayTimer = setTimeout(() => {
    const awayMs     = Date.now() - session.awayStart;
    const limitLabel = formatDuration(dispLimit);
    const awayLabel  = formatDuration(awayMs);

    // Store with the DISPLAY limit so overtime math in reports makes sense
    session.overtimeEvents.push({ type: statusKey, duration: awayMs, limit: dispLimit, time: Date.now() });

    send(chatId,
      `⚠️ *超时提醒 / Overtime Alert!*\n\n` +
      `${mention} 已经 ${STATUS_LABELS[statusKey]} *${awayLabel}*\n` +
      `已超过限制 ${limitLabel}，算迟到！请马上回座！\n` +
      `Over the ${limitLabel} limit — counted as late. Please return to your seat!`
    );

    sendAdmin(
      `🚨 *OVERTIME ALERT*\n\n` +
      `👤 Staff: ${name}\n` +
      `📍 ${STATUS_LABELS[statusKey]}\n` +
      `⏱ Away: ${awayLabel} (limit: ${limitLabel})\n` +
      `🕐 ${nowCambodiaStr()} Cambodia`
    );
  }, limit);
}

// ─── DAILY REPORT ──────────────────────────────────────────────────────────
function generateDailyReport() {
  const now       = Date.now();
  const camTime   = nowCambodiaStr();
  const camDate   = nowCambodiaDateStr();
  const staffList = Object.entries(sessions);

  if (staffList.length === 0) {
    return `📊 *DAILY REPORT — ${camDate}*\n🕐 ${camTime} Cambodia\n\nNo staff records today.`;
  }

  let lateList      = [];
  let overtimeList  = [];
  let issueRows     = [];
  let allRows       = [];
  let totalStaff    = 0;

  staffList.forEach(([uid, s]) => {
    if (!s.name || !s.workStart) return;
    totalStaff++;

    const totalMs       = now - s.workStart;
    const currentAwayMs = s.awayStart ? (now - s.awayStart) : 0;
    const workMs        = totalMs - s.totalAwayMs - currentAwayMs;

    // Clock-out time
    let clockOut = "—";
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) clockOut = offEntry.timeStr || "—";
    }

    // Late info
    const lateStr = s.wasLate ? `${s.lateMinutes}min` : "—";
    if (s.wasLate) lateList.push(`${s.name} (${s.lateMinutes}min)`);

    // Overtime info
    let otStr = "—";
    if (s.overtimeEvents.length > 0) {
      const otMins = s.overtimeEvents.map(ev => {
        const overMs = ev.duration - ev.limit;
        const type   = ev.type === "eat" ? "Eat" : ev.type === "toilet" ? "WC" : ev.type === "smoke" ? "Smoke" : "Other";
        return `${type}+${formatDuration(overMs)}`;
      }).join(", ");
      otStr = otMins;
      overtimeList.push(`${s.name} (${otMins})`);
    }

    // Build row
    const name     = s.name.length > 12 ? s.name.slice(0, 11) + "…" : s.name.padEnd(12);
    const inTime   = (s.clockInTime || "—").padEnd(6);
    const outTime  = clockOut.padEnd(6);
    const lateCol  = lateStr.padEnd(6);
    const otCol    = otStr;

    const row = `${name} ${inTime} ${outTime} ${lateCol} ${otCol}`;
    allRows.push(row);
    if (s.wasLate || s.overtimeEvents.length > 0) issueRows.push(row);
  });

  // ── Build report ────────────────────────────────────────────────────────
  let report = `📊 *DAILY REPORT — ${camDate}*\n`;
  report += `🕐 ${camTime} Cambodia\n`;
  report += `${"═".repeat(28)}\n\n`;

  // Issues summary
  if (lateList.length === 0 && overtimeList.length === 0) {
    report += `✅ *No issues today! Great work!*\n\n`;
  } else {
    report += `⚠️ *ISSUES TODAY*\n`;
    if (lateList.length > 0) report += `🚨 Late: ${lateList.join(", ")}\n`;
    if (overtimeList.length > 0) report += `⏱ Overtime: ${overtimeList.join(", ")}\n`;
    report += "\n";
  }

  // Table header
  report += `${"═".repeat(28)}\n`;
  report += `👥 *FULL STAFF LOG*\n\`\`\`\n`;
  report += `${"─".repeat(45)}\n`;
  report += `Name          In     Out    Late   OT\n`;
  report += `${"─".repeat(45)}\n`;
  allRows.forEach(row => { report += row + "\n"; });
  report += `${"─".repeat(45)}\n`;
  report += `\`\`\`\n`;

  // Footer summary
  report += `👥 Total: ${totalStaff} | 🚨 Late: ${lateList.length} | ⏱ OT: ${overtimeList.length}`;

  return report;
}

function resetDailySessions() {
  Object.keys(sessions).forEach(uid => {
    const s = sessions[uid];
    s.status = "idle"; s.workStart = null; s.awayStart = null;
    s.awayType = null; s.awayTimer = null; s.totalAwayMs = 0;
    s.log = []; s.wasLate = false; s.lateMinutes = 0;
    s.overtimeEvents = []; s.clockInTime = null;
  });
}

// ─── REPORT SCHEDULER ──────────────────────────────────────────────────────
// Fires any time at or after 03:30 UTC (10:30 AM Cambodia) if not sent today.
// Using a window (not exact minute) means a server restart won't skip it.
const REPORT_TRIGGER_MIN = REPORT_UTC_HOUR * 60 + REPORT_UTC_MIN; // minutes since UTC midnight

setInterval(async () => {
  const now      = new Date();
  const today    = nowCambodiaDateStr();
  const nowMin   = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Report window: from 03:30 UTC up to 04:30 UTC (gives a 1-hour safety window)
  const inWindow = nowMin >= REPORT_TRIGGER_MIN && nowMin < REPORT_TRIGGER_MIN + 60;

  if (inWindow && lastReportDate !== today) {
    lastReportDate = today;
    console.log(`📊 Sending daily Excel report... (${today} at ${nowCambodiaStr()} Cambodia)`);

    try {
      const result = generateTxtFile();
      if (result) {
        // Send the txt file to admin
        await bot.sendDocument(ADMIN_CHAT_ID, result.filepath, {
          caption: `📊 DAILY REPORT — ${result.camDate}\nTotal: ${result.staffCount} staff\n🕐 ${nowCambodiaStr()} Cambodia`,
        });
        fs.unlink(result.filepath, () => {});
      } else {
        sendAdmin(`📊 *DAILY REPORT — ${today}*\n\nNo staff records today.`);
      }
    } catch (err) {
      console.error("Daily txt report error:", err.message);
      // Fallback to text message if file fails
      sendAdmin(generateDailyReport());
    }

    setTimeout(() => { resetDailySessions(); console.log("🔄 Sessions reset for new day."); }, 8000);
  }
}, 30 * 1000); // check every 30 seconds

console.log(`⏰ Report scheduler active — sends Excel daily at 10:30 AM Cambodia`);

// ─── BLOCKED COMMANDS ──────────────────────────────────────────────────────
const BLOCKED_PATTERNS = [/\/timer/i, /\/schedule/i, /\/remind/i, /\/auto/i, /\/alarm/i, /set.?timer/i, /set.?reminder/i, /auto.?clock/i];

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
  let report = `👥 *CURRENT STAFF STATUS*\n🕐 ${nowCambodiaStr()} Cambodia\n\n`;
  staffList.forEach(([uid, s]) => { if (s.name) report += `• *${s.name}* → ${STATUS_LABELS[s.status]}\n`; });
  bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
});

// ─── GENERATE EXCEL FILE (reusable) ────────────────────────────────────────
// ─── GENERATE TXT FILE (openable in Notepad) ───────────────────────────────
function generateTxtFile() {
  const now       = Date.now();
  const camDate   = nowCambodiaDateStr();
  const camTime   = nowCambodiaStr();
  const staffList = Object.entries(sessions).filter(([uid, s]) => s.name && s.workStart);

  if (staffList.length === 0) return null;

  let txt = "";
  txt += "========================================\n";
  txt += `       每日报告 / DAILY REPORT\n`;
  txt += `       日期 Date: ${camDate}\n`;
  txt += `       生成时间 Generated: ${camTime} Cambodia\n`;
  txt += "========================================\n\n";

  let lateList = [], overtimeList = [], lateCount = 0, otCount = 0;

  // Build detailed records
  staffList.forEach(([uid, s], index) => {
    const totalMs       = now - s.workStart;
    const currentAwayMs = s.awayStart ? (now - s.awayStart) : 0;
    const workMs        = totalMs - s.totalAwayMs - currentAwayMs;

    let clockOut = "—";
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) clockOut = offEntry.timeStr || "—";
    }

    let overtimeStr = "无 None";
    if (s.overtimeEvents.length > 0) {
      overtimeStr = s.overtimeEvents.map(ev => {
        const type = ev.type === "eat" ? "吃饭Eat" : ev.type === "toilet" ? "厕所Toilet" : ev.type === "smoke" ? "抽烟Smoke" : "其他Other";
        return `${type} +${formatDuration(ev.duration - ev.limit)}`;
      }).join(", ");
      otCount++;
    }

    if (s.wasLate) { lateList.push(`${s.name} (${s.lateMinutes} min)`); lateCount++; }
    if (s.overtimeEvents.length > 0) overtimeList.push(`${s.name} (${overtimeStr})`);

    txt += `${index + 1}. ${s.name}\n`;
    txt += `   上班 Clock-in   : ${s.clockInTime || "—"}\n`;
    txt += `   下班 Clock-out  : ${clockOut}\n`;
    txt += `   工作时间 Work   : ${formatDuration(workMs)}\n`;
    txt += `   离开时间 Away   : ${formatDuration(s.totalAwayMs + currentAwayMs)}\n`;
    txt += `   迟到 Late       : ${s.wasLate ? s.lateMinutes + " min" : "无 No"}\n`;
    txt += `   超时 Overtime   : ${overtimeStr}\n`;
    txt += "   ----------------------------------------\n";
  });

  // Summary section
  txt += "\n========================================\n";
  txt += "       总结 / SUMMARY\n";
  txt += "========================================\n";
  txt += `总人数 Total staff : ${staffList.length}\n`;
  txt += `迟到 Late          : ${lateCount}\n`;
  txt += `超时 Overtime      : ${otCount}\n\n`;

  if (lateList.length > 0) {
    txt += "迟到名单 LATE STAFF:\n";
    lateList.forEach(l => { txt += `  - ${l}\n`; });
    txt += "\n";
  }
  if (overtimeList.length > 0) {
    txt += "超时名单 OVERTIME STAFF:\n";
    overtimeList.forEach(o => { txt += `  - ${o}\n`; });
    txt += "\n";
  }
  if (lateList.length === 0 && overtimeList.length === 0) {
    txt += "今天没有问题！很棒！No issues today! Great work!\n\n";
  }

  txt += "========================================\n";
  txt += "       报告结束 / End of Report\n";
  txt += "========================================\n";

  const filename = `staff_report_${camDate}.txt`;
  const filepath = `/tmp/${filename}`;
  fs.writeFileSync(filepath, txt, "utf8");

  return { filepath, staffCount: staffList.length, camDate };
}

// ─── GENERATE EXCEL FILE (reusable) ────────────────────────────────────────
async function generateExcelFile() {
  const now       = Date.now();
  const camDate   = nowCambodiaDateStr();
  const staffList = Object.entries(sessions).filter(([uid, s]) => s.name && s.workStart);

  if (staffList.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  const sheet    = workbook.addWorksheet(`Records ${camDate}`);

  sheet.columns = [
    { header: "Name",       key: "name",     width: 20 },
    { header: "Clock-in",   key: "in",       width: 12 },
    { header: "Clock-out",  key: "out",      width: 12 },
    { header: "Work Time",  key: "work",     width: 12 },
    { header: "Away Time",  key: "away",     width: 12 },
    { header: "Late",       key: "late",     width: 10 },
    { header: "Overtime",   key: "overtime", width: 18 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B5278" } };
  sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  staffList.forEach(([uid, s]) => {
    const totalMs       = now - s.workStart;
    const currentAwayMs = s.awayStart ? (now - s.awayStart) : 0;
    const workMs        = totalMs - s.totalAwayMs - currentAwayMs;

    let clockOut = "—";
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) clockOut = offEntry.timeStr || "—";
    }

    let overtimeStr = "—";
    if (s.overtimeEvents.length > 0) {
      overtimeStr = s.overtimeEvents.map(ev => {
        const type = ev.type === "eat" ? "Eat" : ev.type === "toilet" ? "Toilet" : ev.type === "smoke" ? "Smoke" : "Other";
        return `${type} +${formatDuration(ev.duration - ev.limit)}`;
      }).join(", ");
    }

    sheet.addRow({
      name:     s.name,
      in:       s.clockInTime || "—",
      out:      clockOut,
      work:     formatDuration(workMs),
      away:     formatDuration(s.totalAwayMs + currentAwayMs),
      late:     s.wasLate ? `${s.lateMinutes} min` : "—",
      overtime: overtimeStr,
    });
  });

  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top:    { style: "thin" },
        left:   { style: "thin" },
        bottom: { style: "thin" },
        right:  { style: "thin" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });

  const filename = `staff_records_${camDate}.xlsx`;
  const filepath = `/tmp/${filename}`;
  await workbook.xlsx.writeFile(filepath);

  return { filepath, staffCount: staffList.length, camDate };
}

// ─── /export (txt file of today's records, opens in Notepad) ───────────────
bot.onText(/\/export/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");

  try {
    await bot.sendMessage(msg.chat.id, "⏳ 生成文件中 / Generating file...");
    const result = generateTxtFile();

    if (!result) {
      return bot.sendMessage(msg.chat.id, "📋 今天暂无记录 / No staff records to export today.");
    }

    await bot.sendDocument(msg.chat.id, result.filepath, {
      caption: `📊 员工记录 / Staff Records — ${result.camDate}\n总数 Total: ${result.staffCount} staff`,
    });

    fs.unlink(result.filepath, () => {});
  } catch (err) {
    console.error("Export error:", err.message);
    bot.sendMessage(msg.chat.id, "❌ 生成失败 / Failed to generate file. Please try again.");
  }
});

// ─── /exportexcel (Excel version, if ever needed) ──────────────────────────
bot.onText(/\/exportexcel/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");

  try {
    await bot.sendMessage(msg.chat.id, "⏳ Generating Excel file...");
    const result = await generateExcelFile();

    if (!result) {
      return bot.sendMessage(msg.chat.id, "📋 No staff records to export today.");
    }

    await bot.sendDocument(msg.chat.id, result.filepath, {
      caption: `📊 Staff Records — ${result.camDate}\nTotal: ${result.staffCount} staff`,
    });

    fs.unlink(result.filepath, () => {});
  } catch (err) {
    console.error("Export Excel error:", err.message);
    bot.sendMessage(msg.chat.id, "❌ Failed to generate Excel. Please try again.");
  }
});

// ─── MESSAGES ──────────────────────────────────────────────────────────────
bot.on("message", (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id; // ALWAYS the person who sent the message
  const text    = msg.text;
  const session = getSession(userId);
  const t       = Date.now();

  // ALWAYS use msg.from — ignore any reply_to_message
  session.name   = getName(msg);
  const mention  = getMention(msg);
  const camTime  = nowCambodiaStr();

  if (!text) return;

  // ── BLOCK AUTO CLOCK-IN ─────────────────────────────────────────────────
  if (BLOCKED_PATTERNS.some(p => p.test(text))) {
    send(chatId, `🚫 *Auto clock-in is not allowed!*\n\n${mention} Please tap the button manually.`);
    sendAdmin(`⚠️ *AUTO CLOCK-IN ATTEMPT*\n\n👤 Staff: ${session.name}\n💬 Message: ${text}\n🕐 ${camTime} Cambodia`);
    return;
  }

  if (text.startsWith("/")) return;

  // ── START WORK ───────────────────────────────────────────────────────────
  if (text.includes("Start Work") || text.includes("上班")) {
    if (session.status !== "idle" && session.status !== "off") {
      return send(chatId, `⚠️ ${mention} 你已经上班了！\nYou already clocked in.`);
    }
    session.status = "work"; session.workStart = t;
    session.totalAwayMs = 0; session.clockInTime = camTime;
    session.log = [{ action: "上班 Start Work", time: t, timeStr: camTime }];

    let msg2 = `✅ *上班打卡成功 / Clocked in!*\n👤 ${mention}\n⏰ 上班时间 Clock-in: \`${camTime}\` Cambodia\n\n状态 Status: ${STATUS_LABELS["work"]}`;

    if (isLate()) {
      const minsLate = getMinutesLate();
      session.wasLate = true; session.lateMinutes = minsLate;
      msg2 += `\n\n🚨 *${mention} 迟到 ${minsLate} 分钟 / LATE by ${minsLate} min!*\n⏰ 应在 9:00 PM 上班`;
      sendAdmin(`🚨 *LATE ARRIVAL / 迟到*\n\n👤 Staff: ${session.name}\n⏰ Clock-in: ${camTime} Cambodia\n📌 Should start: 9:00 PM\n⏱ Late by: *${minsLate} minute(s)*`);
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
    const totalMs = t - session.workStart;
    const workMs  = totalMs - session.totalAwayMs;
    session.status = "off";

    send(chatId,
      `🔴 *下班打卡 / Clocked out!*\n👤 ${mention}\n⏰ 下班时间 Clock-out: \`${camTime}\` Cambodia\n` +
      `🕐 总时间 Total: \`${formatDuration(totalMs)}\`\n💼 工作 Work: \`${formatDuration(workMs)}\`\n🚶 离开 Away: \`${formatDuration(session.totalAwayMs)}\``, true);

    sendAdmin(`📋 *CLOCKED OUT*\n\n👤 Staff: ${session.name}\n⏰ Clock-out: ${camTime} Cambodia\n` +
      `🕐 Total: ${formatDuration(totalMs)}\n💼 Work: ${formatDuration(workMs)}\n🚶 Away: ${formatDuration(session.totalAwayMs)}`);
  }

  // ── AWAY ACTIONS ─────────────────────────────────────────────────────────
  else if (
    text.includes("Eat") || text.includes("吃饭") || text.includes("Toilet") || text.includes("厕所") ||
    text.includes("Smoke") || text.includes("抽烟") || text.includes("Other") || text.includes("其他")
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

    session.status = statusKey; session.awayStart = t;
    session.awayType = statusKey;
    session.log.push({ action: text.trim(), time: t, timeStr: camTime });

    send(chatId,
      `${emoji} ${mention} → *${STATUS_LABELS[statusKey]}*\n时间 Time: \`${camTime}\` Cambodia\n⏱ 限制 Limit: ${formatDuration(DISPLAY_LIMITS[statusKey])}`, true);
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
    const graceLimitMs = AWAY_LIMITS[session.awayType] || 0;      // fires at +1 min
    const dispLimitMs  = DISPLAY_LIMITS[session.awayType] || 0;   // friendly number
    const wasOvertime  = awayDuration >= graceLimitMs;            // late only if hit 31min
    session.status     = "work";
    session.log.push({ action: "回座 Back to Seat", time: t, timeStr: camTime });

    let msg2 = `💺 ${mention} *回座成功 / Back to seat!*\n时间 Time: \`${camTime}\` Cambodia\n离开 Away: \`${formatDuration(awayDuration)}\``;
    if (wasOvertime) msg2 += `\n⚠️ 超时算迟到 Overtime by *${formatDuration(awayDuration - dispLimitMs)}*!`;
    send(chatId, msg2, true);
  }
});

// ─── ERRORS ────────────────────────────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err.message));
console.log("✅ Work Check-in Bot is running... (Cambodia GMT+7)");
console.log("⏰ Report scheduler started — sends daily at 10:30 AM Cambodia (03:30 UTC)");
