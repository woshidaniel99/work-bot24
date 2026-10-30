const TelegramBot = require("node-telegram-bot-api");
const ExcelJS     = require("exceljs");
const fs          = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TOKEN           = process.env.TOKEN;
const ADMIN_CHAT_ID   = process.env.ADMIN_CHAT_ID;   // Client's admin (the boss)
const GROUP_CHAT_ID   = process.env.GROUP_CHAT_ID;
const REPORT_GROUP_ID = process.env.REPORT_GROUP_ID; // Reports sent to this group instead of admins
const SUPER_ADMIN_ID  = process.env.SUPER_ADMIN_ID;  // Your ID (optional) — you monitor all bots
const COUNTRY         = process.env.COUNTRY || "Philippines"; // Displayed in messages

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── TIMEZONE ──────────────────────────────────────────────────────────────
// Defaults: Philippines (UTC+8), work 8:00 PM → 8:00 AM, report 10:30 AM.
// Railway Variables (optional — they OVERRIDE these defaults if set):
//   TZ_OFFSET, WORK_START_HOUR, WORK_START_MIN, WORK_END_HOUR, WORK_END_MIN,
//   MIN_WORK_HOURS, REPORT_HOUR, REPORT_MIN, MAX_AWAY_HOURS

const TZ_OFFSET_HOURS     = parseInt(process.env.TZ_OFFSET       || "8");
const WORK_START_LOC_HOUR = parseInt(process.env.WORK_START_HOUR || "20");  // 8 PM
const WORK_START_LOC_MIN  = parseInt(process.env.WORK_START_MIN  || "0");
const WORK_END_LOC_HOUR   = parseInt(process.env.WORK_END_HOUR   || "8");   // 8 AM
const WORK_END_LOC_MIN    = parseInt(process.env.WORK_END_MIN    || "0");
const MIN_WORK_HOURS      = parseFloat(process.env.MIN_WORK_HOURS || "12");
const REPORT_LOC_HOUR     = parseInt(process.env.REPORT_HOUR     || "10");
const REPORT_LOC_MIN      = parseInt(process.env.REPORT_MIN      || "30");

// Convert local hour to UTC hour
function locHourToUtc(h) {
  const utc = h - TZ_OFFSET_HOURS;
  if (utc < 0) return utc + 24;
  if (utc >= 24) return utc - 24;
  return utc;
}

const REPORT_UTC_HOUR = locHourToUtc(REPORT_LOC_HOUR);
const REPORT_UTC_MIN  = REPORT_LOC_MIN;

function hhmm(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const START_TIME_STR  = hhmm(WORK_START_LOC_HOUR, WORK_START_LOC_MIN);
const END_TIME_STR    = hhmm(WORK_END_LOC_HOUR, WORK_END_LOC_MIN);
const REPORT_TIME_STR = hhmm(REPORT_LOC_HOUR, REPORT_LOC_MIN);

console.log(`⚙️  Timezone: UTC${TZ_OFFSET_HOURS >= 0 ? "+" : ""}${TZ_OFFSET_HOURS} (${COUNTRY})`);
console.log(`⚙️  Shift: ${START_TIME_STR} → ${END_TIME_STR} ${COUNTRY}`);
console.log(`⚙️  Daily report at ${REPORT_TIME_STR} ${COUNTRY}`);

// ─── BREAK LIMITS ──────────────────────────────────────────────────────────
// The displayed limit is the "soft" limit. Staff have a grace period until the
// NEXT full minute. e.g. Eat 30min → 30:00–30:59 is OK, alert fires at 31:00.
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

// ─── DAILY QUOTAS ──────────────────────────────────────────────────────────
// How many times per shift each break type is allowed
const DAILY_QUOTAS = {
  eat:    3,   // max 3 times
  toilet: 7,   // max 7 times
  smoke:  7,   // max 7 times
  other:  5,   // max 5 times
};

// Total maximum away time per shift (default 2 hours)
const MAX_AWAY_HOURS    = parseFloat(process.env.MAX_AWAY_HOURS || "2");
const MAX_DAILY_AWAY_MS = MAX_AWAY_HOURS * 60 * 60 * 1000;

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
      wasEarlyOut: false,
      overtimeEvents: [],
      clockInTime: null,
      breakCounts: { eat: 0, toilet: 0, smoke: 0, other: 0 },
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

function localNow() {
  return new Date(Date.now() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
}

function nowLocalStr() {
  const d = localNow();
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function nowLocalDateStr() {
  return localNow().toISOString().slice(0, 10);
}

function nowLocalMinutes() {
  const d = localNow();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ── ALWAYS use the user's unique ID for mentions ───────────────────────────
function getMention(msg) {
  const user = msg.from;
  let name   = user.first_name || user.username || "Staff";
  name = name.replace(/[\[\]()]/g, "");
  return `[${name}](tg://user?id=${user.id})`;
}

function getName(msg) {
  const user  = msg.from;
  const first = user.first_name || "";
  const last  = user.last_name  || "";
  return (first + " " + last).trim() || "Staff";
}

function getAdminIds() {
  const adminIds = new Set();
  if (ADMIN_CHAT_ID) {
    ADMIN_CHAT_ID.split(",").forEach(id => {
      const trimmed = id.trim();
      if (trimmed && trimmed !== "YOUR_ADMIN_CHAT_ID") adminIds.add(trimmed);
    });
  }
  if (SUPER_ADMIN_ID) adminIds.add(String(SUPER_ADMIN_ID).trim());
  return adminIds;
}

function sendAdmin(message) {
  getAdminIds().forEach(id => {
    bot.sendMessage(id, message, { parse_mode: "Markdown" }).catch(() => {});
  });
}

function send(chatId, message, withKeyboard) {
  const opts = { parse_mode: "Markdown" };
  if (withKeyboard) opts.reply_markup = getMainKeyboard();
  bot.sendMessage(chatId, message, opts).catch(() => {});
}

// ─── SHIFT CHECKS ──────────────────────────────────────────────────────────
const SHIFT_START_MIN = WORK_START_LOC_HOUR * 60 + WORK_START_LOC_MIN;
const SHIFT_END_MIN   = WORK_END_LOC_HOUR * 60 + WORK_END_LOC_MIN;
const IS_OVERNIGHT    = SHIFT_START_MIN > SHIFT_END_MIN;

// Is the current time inside the shift window?
function isInsideShift(nowMin) {
  if (IS_OVERNIGHT) {
    // e.g. 20:00 → 08:00: inside if after 20:00 OR before 08:00
    return nowMin >= SHIFT_START_MIN || nowMin < SHIFT_END_MIN;
  }
  return nowMin >= SHIFT_START_MIN && nowMin < SHIFT_END_MIN;
}

// Late = clocked in after shift start, but still inside the shift
// (covers clock-ins after midnight on overnight shifts too)
function isLate() {
  const nowMin = nowLocalMinutes();
  return isInsideShift(nowMin) && nowMin !== SHIFT_START_MIN;
}

function getMinutesLate() {
  const diff = nowLocalMinutes() - SHIFT_START_MIN;
  return diff < 0 ? diff + 1440 : diff; // handle wrap past midnight
}

function isEarlyClockOut(workStartMs) {
  const nowMin = nowLocalMinutes();

  // Check 1: still inside the shift window (shift end not reached yet)
  const beforeEnd = isInsideShift(nowMin);

  // Check 2: worked less than MIN_WORK_HOURS
  const workedHours    = (Date.now() - workStartMs) / (60 * 60 * 1000);
  const notEnoughHours = workedHours < MIN_WORK_HOURS;

  if (beforeEnd || notEnoughHours) {
    const reasons = [];
    if (beforeEnd)      reasons.push(`before shift end ${END_TIME_STR}`);
    if (notEnoughHours) reasons.push(`only worked ${workedHours.toFixed(1)}h (needs ${MIN_WORK_HOURS}h)`);
    return { early: true, reason: reasons.join(" & "), workedHours };
  }
  return { early: false, workedHours };
}

function isAdmin(userId) {
  return getAdminIds().has(String(userId));
}

// ─── KEYBOARD ──────────────────────────────────────────────────────────────
function getMainKeyboard() {
  return {
    keyboard: [
      [{ text: "上班 / Start Work / Bắt đầu" }, { text: "下班 / Off Work / Tan làm" }],
      [{ text: "吃饭 / Eat / Ăn cơm" }, { text: "上厕所 / Toilet / Vệ sinh" }, { text: "抽烟 / Smoke / Hút thuốc" }],
      [{ text: "其他 / Other / Khác" }],
      [{ text: "回座 / Back to Seat / Trở lại chỗ" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ─── STATUS LABELS ─────────────────────────────────────────────────────────
const STATUS_LABELS = {
  work:   "🟢 上班中 / Working / Đang làm",
  eat:    "🍜 吃饭中 / Eating / Ăn cơm",
  toilet: "🚻 上厕所 / Toilet / Vệ sinh",
  smoke:  "🚬 抽烟 / Smoking / Hút thuốc",
  other:  "🔵 其他 / Other / Khác",
  off:    "🔴 已下班 / Off Work / Đã tan",
  idle:   "⬜ 未上班 / Not Started / Chưa bắt đầu",
};

// ─── AWAY TIMER ────────────────────────────────────────────────────────────
function startAwayTimer(userId, chatId, statusKey, mention, name) {
  const session   = getSession(userId);
  const limit     = AWAY_LIMITS[statusKey];
  const dispLimit = DISPLAY_LIMITS[statusKey];
  if (!limit) return;
  if (session.awayTimer) clearTimeout(session.awayTimer);

  session.awayTimer = setTimeout(() => {
    const awayMs     = Date.now() - session.awayStart;
    const limitLabel = formatDuration(dispLimit);
    const awayLabel  = formatDuration(awayMs);

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
      `🕐 ${nowLocalStr()} ${COUNTRY}`
    );
  }, limit);
}

// ─── DAILY REPORT (text message version) ───────────────────────────────────
function generateDailyReport() {
  const now       = Date.now();
  const locTime   = nowLocalStr();
  const locDate   = nowLocalDateStr();
  const staffList = Object.entries(sessions);

  if (staffList.length === 0) {
    return `📊 *DAILY REPORT — ${locDate}*\n🕐 ${locTime} ${COUNTRY}\n\nNo staff records today.`;
  }

  let lateList     = [];
  let overtimeList = [];
  let allRows      = [];
  let totalStaff   = 0;

  staffList.forEach(([uid, s]) => {
    if (!s.name || !s.workStart) return;
    totalStaff++;

    let clockOut = "—";
    if (s.status === "off" && s.log) {
      const offEntry = s.log.find(l => l.action.includes("Off Work"));
      if (offEntry) clockOut = offEntry.timeStr || "—";
    }

    const lateStr = s.wasLate ? `${s.lateMinutes}min` : "—";
    if (s.wasLate) lateList.push(`${s.name} (${s.lateMinutes}min)`);

    let otStr = "—";
    if (s.overtimeEvents.length > 0) {
      otStr = s.overtimeEvents.map(ev => {
        const overMs = ev.duration - ev.limit;
        const type   = ev.type === "eat" ? "Eat" : ev.type === "toilet" ? "WC" : ev.type === "smoke" ? "Smoke" : "Other";
        return `${type}+${formatDuration(overMs)}`;
      }).join(", ");
      overtimeList.push(`${s.name} (${otStr})`);
    }

    const name    = s.name.length > 12 ? s.name.slice(0, 11) + "…" : s.name.padEnd(12);
    const inTime  = (s.clockInTime || "—").padEnd(6);
    const outTime = clockOut.padEnd(6);
    const lateCol = lateStr.padEnd(6);

    allRows.push(`${name} ${inTime} ${outTime} ${lateCol} ${otStr}`);
  });

  let report = `📊 *DAILY REPORT — ${locDate}*\n`;
  report += `🕐 ${locTime} ${COUNTRY}\n`;
  report += `${"═".repeat(28)}\n\n`;

  if (lateList.length === 0 && overtimeList.length === 0) {
    report += `✅ *No issues today! Great work!*\n\n`;
  } else {
    report += `⚠️ *ISSUES TODAY*\n`;
    if (lateList.length > 0)     report += `🚨 Late: ${lateList.join(", ")}\n`;
    if (overtimeList.length > 0) report += `⏱ Overtime: ${overtimeList.join(", ")}\n`;
    report += "\n";
  }

  report += `${"═".repeat(28)}\n`;
  report += `👥 *FULL STAFF LOG*\n\`\`\`\n`;
  report += `${"─".repeat(45)}\n`;
  report += `Name          In     Out    Late   OT\n`;
  report += `${"─".repeat(45)}\n`;
  allRows.forEach(row => { report += row + "\n"; });
  report += `${"─".repeat(45)}\n`;
  report += `\`\`\`\n`;

  report += `👥 Total: ${totalStaff} | 🚨 Late: ${lateList.length} | ⏱ OT: ${overtimeList.length}`;

  return report;
}

function resetDailySessions() {
  Object.keys(sessions).forEach(uid => {
    const s = sessions[uid];
    if (s.awayTimer) clearTimeout(s.awayTimer);
    s.status = "idle"; s.workStart = null; s.awayStart = null;
    s.awayType = null; s.awayTimer = null; s.totalAwayMs = 0;
    s.log = []; s.wasLate = false; s.lateMinutes = 0; s.wasEarlyOut = false;
    s.overtimeEvents = []; s.clockInTime = null;
    s.breakCounts = { eat: 0, toilet: 0, smoke: 0, other: 0 };
  });
}

// ─── REPORT SCHEDULER ──────────────────────────────────────────────────────
// Fires any time within 1 hour after the report time if not sent today.
// Using a window (not exact minute) means a server restart won't skip it.
const REPORT_TRIGGER_MIN = REPORT_UTC_HOUR * 60 + REPORT_UTC_MIN; // minutes since UTC midnight

setInterval(async () => {
  const now    = new Date();
  const today  = nowLocalDateStr();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  let diff = nowMin - REPORT_TRIGGER_MIN;
  if (diff < 0) diff += 1440;
  const inWindow = diff < 60;

  if (inWindow && lastReportDate !== today) {
    lastReportDate = today;
    console.log(`📊 Sending daily report... (${today} at ${nowLocalStr()} ${COUNTRY})`);

    try {
      const result = generateTxtFile();
      if (result) {
        const caption = `📊 DAILY REPORT — ${result.locDate}\nTotal: ${result.staffCount} staff\n🕐 ${nowLocalStr()} ${COUNTRY}`;

        if (REPORT_GROUP_ID) {
          await bot.sendDocument(REPORT_GROUP_ID, result.filepath, { caption }).catch((e) => {
            console.error("Report send to group error:", e.message);
          });
          if (SUPER_ADMIN_ID) {
            await bot.sendDocument(SUPER_ADMIN_ID, result.filepath, { caption }).catch(() => {});
          }
        } else {
          for (const id of getAdminIds()) {
            await bot.sendDocument(id, result.filepath, { caption }).catch(() => {});
          }
        }

        fs.unlink(result.filepath, () => {});
      } else {
        const noRecords = `📊 *DAILY REPORT — ${today}*\n\nNo staff records today.`;
        if (REPORT_GROUP_ID) {
          bot.sendMessage(REPORT_GROUP_ID, noRecords, { parse_mode: "Markdown" }).catch(() => {});
        } else {
          sendAdmin(noRecords);
        }
      }
    } catch (err) {
      console.error("Daily txt report error:", err.message);
      sendAdmin(generateDailyReport());
    }

    setTimeout(() => { resetDailySessions(); console.log("🔄 Sessions reset for new day."); }, 8000);
  }
}, 30 * 1000); // check every 30 seconds

// ─── BLOCKED COMMANDS ──────────────────────────────────────────────────────
const BLOCKED_PATTERNS = [/\/timer/i, /\/schedule/i, /\/remind/i, /\/auto/i, /\/alarm/i, /set.?timer/i, /set.?reminder/i, /auto.?clock/i];

// ─── /start ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const session = getSession(msg.from.id);
  session.name  = getName(msg);
  bot.sendMessage(msg.chat.id,
    `👋 你好 ${msg.from.first_name || "朋友"}！\n\n请直接点击按钮打卡\nPlease tap a button to check in.\n\n` +
    `⏰ 上班时间 Shift: ${START_TIME_STR} → ${END_TIME_STR} ${COUNTRY}\n\nStatus: ${STATUS_LABELS[session.status]}`,
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
  let report = `👥 *CURRENT STAFF STATUS*\n🕐 ${nowLocalStr()} ${COUNTRY}\n\n`;
  staffList.forEach(([uid, s]) => { if (s.name) report += `• *${s.name}* → ${STATUS_LABELS[s.status]}\n`; });
  bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
});

// ─── GENERATE TXT FILE (openable in Notepad) ───────────────────────────────
function generateTxtFile() {
  const now       = Date.now();
  const locDate   = nowLocalDateStr();
  const locTime   = nowLocalStr();
  const staffList = Object.entries(sessions).filter(([uid, s]) => s.name && s.workStart);

  if (staffList.length === 0) return null;

  let txt = "";
  txt += "========================================\n";
  txt += `       每日报告 / DAILY REPORT\n`;
  txt += `       日期 Date: ${locDate}\n`;
  txt += `       生成时间 Generated: ${locTime} ${COUNTRY}\n`;
  txt += `       上班时间 Shift: ${START_TIME_STR} → ${END_TIME_STR}\n`;
  txt += "========================================\n\n";

  let lateList = [], overtimeList = [], earlyList = [], lateCount = 0, otCount = 0;

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
    if (s.wasEarlyOut) earlyList.push(s.name);

    const bc = s.breakCounts || {};
    txt += `${index + 1}. ${s.name}\n`;
    txt += `   上班 Clock-in   : ${s.clockInTime || "—"}\n`;
    txt += `   下班 Clock-out  : ${clockOut}${s.wasEarlyOut ? "  (提早下班 EARLY)" : ""}\n`;
    txt += `   工作时间 Work   : ${formatDuration(workMs)}\n`;
    txt += `   离开时间 Away   : ${formatDuration(s.totalAwayMs + currentAwayMs)} / ${MAX_AWAY_HOURS}h\n`;
    txt += `   次数 Breaks     : 吃饭Eat ${bc.eat || 0}/${DAILY_QUOTAS.eat}, 厕所WC ${bc.toilet || 0}/${DAILY_QUOTAS.toilet}, 抽烟Smoke ${bc.smoke || 0}/${DAILY_QUOTAS.smoke}, 其他Other ${bc.other || 0}/${DAILY_QUOTAS.other}\n`;
    txt += `   迟到 Late       : ${s.wasLate ? s.lateMinutes + " min" : "无 No"}\n`;
    txt += `   超时 Overtime   : ${overtimeStr}\n`;
    txt += "   ----------------------------------------\n";
  });

  txt += "\n========================================\n";
  txt += "       总结 / SUMMARY\n";
  txt += "========================================\n";
  txt += `总人数 Total staff : ${staffList.length}\n`;
  txt += `迟到 Late          : ${lateCount}\n`;
  txt += `超时 Overtime      : ${otCount}\n`;
  txt += `提早下班 Early out : ${earlyList.length}\n\n`;

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
  if (earlyList.length > 0) {
    txt += "提早下班名单 EARLY CLOCK-OUT:\n";
    earlyList.forEach(e => { txt += `  - ${e}\n`; });
    txt += "\n";
  }
  if (lateList.length === 0 && overtimeList.length === 0 && earlyList.length === 0) {
    txt += "今天没有问题！很棒！No issues today! Great work!\n\n";
  }

  txt += "========================================\n";
  txt += "       报告结束 / End of Report\n";
  txt += "========================================\n";

  const filename = `staff_report_${locDate}.txt`;
  const filepath = `/tmp/${filename}`;
  fs.writeFileSync(filepath, txt, "utf8");

  return { filepath, staffCount: staffList.length, locDate };
}

// ─── GENERATE EXCEL FILE ───────────────────────────────────────────────────
async function generateExcelFile() {
  const now       = Date.now();
  const locDate   = nowLocalDateStr();
  const staffList = Object.entries(sessions).filter(([uid, s]) => s.name && s.workStart);

  if (staffList.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  const sheet    = workbook.addWorksheet(`Records ${locDate}`);

  sheet.columns = [
    { header: "Name",       key: "name",     width: 20 },
    { header: "Clock-in",   key: "in",       width: 12 },
    { header: "Clock-out",  key: "out",      width: 12 },
    { header: "Work Time",  key: "work",     width: 12 },
    { header: "Away Time",  key: "away",     width: 12 },
    { header: "Eat Count",  key: "eatCount", width: 10 },
    { header: "Late",       key: "late",     width: 10 },
    { header: "Early Out",  key: "early",    width: 10 },
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
      eatCount: `${(s.breakCounts && s.breakCounts.eat) || 0}/${DAILY_QUOTAS.eat}`,
      late:     s.wasLate ? `${s.lateMinutes} min` : "—",
      early:    s.wasEarlyOut ? "Yes" : "—",
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

  const filename = `staff_records_${locDate}.xlsx`;
  const filepath = `/tmp/${filename}`;
  await workbook.xlsx.writeFile(filepath);

  return { filepath, staffCount: staffList.length, locDate };
}

// ─── /export (txt file, opens in Notepad) ──────────────────────────────────
bot.onText(/\/export$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");

  try {
    await bot.sendMessage(msg.chat.id, "⏳ 生成文件中 / Generating file...");
    const result = generateTxtFile();

    if (!result) {
      return bot.sendMessage(msg.chat.id, "📋 今天暂无记录 / No staff records to export today.");
    }

    await bot.sendDocument(msg.chat.id, result.filepath, {
      caption: `📊 员工记录 / Staff Records — ${result.locDate}\n总数 Total: ${result.staffCount} staff`,
    });

    fs.unlink(result.filepath, () => {});
  } catch (err) {
    console.error("Export error:", err.message);
    bot.sendMessage(msg.chat.id, "❌ 生成失败 / Failed to generate file. Please try again.");
  }
});

// ─── /exportexcel (Excel version) ──────────────────────────────────────────
bot.onText(/\/exportexcel/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Not authorized.");

  try {
    await bot.sendMessage(msg.chat.id, "⏳ Generating Excel file...");
    const result = await generateExcelFile();

    if (!result) {
      return bot.sendMessage(msg.chat.id, "📋 No staff records to export today.");
    }

    await bot.sendDocument(msg.chat.id, result.filepath, {
      caption: `📊 Staff Records — ${result.locDate}\nTotal: ${result.staffCount} staff`,
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

  session.name  = getName(msg);
  const mention = getMention(msg);
  const locTime = nowLocalStr();

  if (!text) return;

  // ── BLOCK AUTO CLOCK-IN ─────────────────────────────────────────────────
  if (BLOCKED_PATTERNS.some(p => p.test(text))) {
    send(chatId, `🚫 *Auto clock-in is not allowed!*\n\n${mention} Please tap the button manually.`);
    sendAdmin(`⚠️ *AUTO CLOCK-IN ATTEMPT*\n\n👤 Staff: ${session.name}\n💬 Message: ${text}\n🕐 ${locTime} ${COUNTRY}`);
    return;
  }

  if (text.startsWith("/")) return;

  // ── START WORK ───────────────────────────────────────────────────────────
  if (text.includes("Start Work") || text.includes("上班") || text.includes("Bắt đầu")) {
    if (session.status !== "idle" && session.status !== "off") {
      return send(chatId, `⚠️ ${mention} 你已经上班了！\nYou already clocked in.`);
    }

    // ── RESUME after accidental Off Work ──────────────────────────────────
    if (session.status === "off" && session.workStart) {
      session.log = session.log.filter(l => !l.action.includes("Off Work"));
      session.status      = "work";
      session.wasEarlyOut = false;
      session.log.push({ action: "恢复上班 Resume Work", time: t, timeStr: locTime });

      const currentWorkMs = (t - session.workStart) - session.totalAwayMs;

      const resumeMsg = `🔄 *继续上班 / Resumed Work!*\n👤 ${mention}\n` +
        `⏰ 原上班时间 Original Clock-in: \`${session.clockInTime}\`\n` +
        `🕐 恢复时间 Resumed at: \`${locTime}\` ${COUNTRY}\n` +
        `💼 已工作 Worked so far: \`${formatDuration(currentWorkMs)}\`\n\n` +
        `状态 Status: ${STATUS_LABELS["work"]}`;

      sendAdmin(`🔄 *WORK RESUMED*\n\n👤 Staff: ${session.name}\n⏰ Original clock-in: ${session.clockInTime}\n🕐 Resumed: ${locTime} ${COUNTRY}\n💼 Worked so far: ${formatDuration(currentWorkMs)}`);
      return send(chatId, resumeMsg, true);
    }

    // ── FRESH clock-in ────────────────────────────────────────────────────
    session.status = "work"; session.workStart = t;
    session.totalAwayMs = 0; session.clockInTime = locTime;
    session.log = [{ action: "上班 Start Work", time: t, timeStr: locTime }];

    let msg2 = `✅ *上班打卡成功 / Clocked in!*\n👤 ${mention}\n⏰ 上班时间 Clock-in: \`${locTime}\` ${COUNTRY}\n\n状态 Status: ${STATUS_LABELS["work"]}`;

    if (isLate()) {
      const minsLate = getMinutesLate();
      session.wasLate = true; session.lateMinutes = minsLate;
      msg2 += `\n\n🚨 ${mention} *迟到 ${minsLate} 分钟 / LATE by ${minsLate} min!*\n⏰ 应在 ${START_TIME_STR} 上班 / Should start at ${START_TIME_STR}`;
      sendAdmin(`🚨 *LATE ARRIVAL / 迟到*\n\n👤 Staff: ${session.name}\n⏰ Clock-in: ${locTime} ${COUNTRY}\n📌 Should start: ${START_TIME_STR}\n⏱ Late by: *${minsLate} minute(s)*`);
    }
    send(chatId, msg2, true);
  }

  // ── OFF WORK ─────────────────────────────────────────────────────────────
  else if (text.includes("Off Work") || text.includes("下班") || text.includes("Tan làm")) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${mention} 你还没上班呢！\nYou haven't clocked in yet.`);
    }
    if (session.awayTimer) { clearTimeout(session.awayTimer); session.awayTimer = null; }
    if (session.awayStart) { session.totalAwayMs += t - session.awayStart; session.awayStart = null; }

    session.log.push({ action: "下班 Off Work", time: t, timeStr: locTime });
    const totalMs = t - session.workStart;
    const workMs  = totalMs - session.totalAwayMs;
    session.status = "off";

    const earlyCheck = isEarlyClockOut(session.workStart);

    let msg2 = `🔴 *下班打卡 / Clocked out!*\n👤 ${mention}\n⏰ 下班时间 Clock-out: \`${locTime}\` ${COUNTRY}\n` +
      `🕐 总时间 Total: \`${formatDuration(totalMs)}\`\n💼 工作 Work: \`${formatDuration(workMs)}\`\n🚶 离开 Away: \`${formatDuration(session.totalAwayMs)}\``;

    if (earlyCheck.early) {
      session.wasEarlyOut = true;
      msg2 += `\n\n🚨 ${mention} *提早下班 / EARLY CLOCK-OUT!*\n` +
              `应工作到 ${END_TIME_STR} 或至少 ${MIN_WORK_HOURS} 小时\n` +
              `Should work until ${END_TIME_STR} or at least ${MIN_WORK_HOURS}h\n` +
              `⏱ Only worked: ${earlyCheck.workedHours.toFixed(1)}h`;

      sendAdmin(
        `🚨 *EARLY CLOCK-OUT*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `⏰ Clock-out: ${locTime} ${COUNTRY}\n` +
        `⏱ Worked: ${earlyCheck.workedHours.toFixed(1)}h (needs ${MIN_WORK_HOURS}h)\n` +
        `📌 Should work until: ${END_TIME_STR}\n` +
        `📝 Reason: ${earlyCheck.reason}`
      );
    } else {
      session.wasEarlyOut = false;
    }

    send(chatId, msg2, true);

    sendAdmin(`📋 *CLOCKED OUT*\n\n👤 Staff: ${session.name}\n⏰ Clock-out: ${locTime} ${COUNTRY}\n` +
      `🕐 Total: ${formatDuration(totalMs)}\n💼 Work: ${formatDuration(workMs)}\n🚶 Away: ${formatDuration(session.totalAwayMs)}${earlyCheck.early ? "\n⚠️ EARLY CLOCK-OUT" : ""}`);
  }

  // ── AWAY ACTIONS ─────────────────────────────────────────────────────────
  else if (
    text.includes("Eat") || text.includes("吃饭") || text.includes("Ăn cơm") ||
    text.includes("Toilet") || text.includes("厕所") || text.includes("Vệ sinh") ||
    text.includes("Smoke") || text.includes("抽烟") || text.includes("Hút thuốc") ||
    text.includes("Other") || text.includes("其他") || text.includes("Khác")
  ) {
    if (session.status === "idle" || session.status === "off") {
      return send(chatId, `⚠️ ${mention} 请先上班打卡！\nPlease clock in first.`);
    }
    if (["eat", "toilet", "smoke", "other"].includes(session.status)) {
      return send(chatId, `⚠️ ${mention} 你已经在: ${STATUS_LABELS[session.status]}`);
    }
    let statusKey = "other"; let emoji = "🔵";
    if (text.includes("Eat")    || text.includes("吃饭") || text.includes("Ăn cơm"))    { statusKey = "eat";    emoji = "🍜"; }
    if (text.includes("Toilet") || text.includes("厕所") || text.includes("Vệ sinh"))   { statusKey = "toilet"; emoji = "🚻"; }
    if (text.includes("Smoke")  || text.includes("抽烟") || text.includes("Hút thuốc")) { statusKey = "smoke";  emoji = "🚬"; }

    // ── CHECK DAILY QUOTA ─────────────────────────────────────────────────
    const currentCount = session.breakCounts[statusKey] || 0;
    const quotaLimit   = DAILY_QUOTAS[statusKey];
    if (currentCount >= quotaLimit) {
      const typeName = { eat: "吃饭/Eat", toilet: "厕所/Toilet", smoke: "抽烟/Smoke", other: "其他/Other" }[statusKey];
      sendAdmin(
        `🚨 *QUOTA EXCEEDED*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `📍 ${STATUS_LABELS[statusKey]}\n` +
        `⏱ Tried: ${currentCount + 1} times (limit: ${quotaLimit})\n` +
        `🕐 ${locTime} ${COUNTRY}`
      );
      return send(chatId,
        `🚫 ${mention} *超过每日限制 / Daily Quota Exceeded!*\n\n` +
        `${typeName} 今日已达 *${quotaLimit}* 次\n` +
        `Already used ${quotaLimit} times today`
      );
    }

    // ── CHECK TOTAL AWAY TIME QUOTA ───────────────────────────────────────
    if (session.totalAwayMs >= MAX_DAILY_AWAY_MS) {
      sendAdmin(
        `🚨 *TOTAL AWAY LIMIT REACHED*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `⏱ Total away: ${formatDuration(session.totalAwayMs)} (limit: ${MAX_AWAY_HOURS}h)\n` +
        `🕐 ${locTime} ${COUNTRY}`
      );
      return send(chatId,
        `🚫 ${mention} *今日离开时间已满 ${MAX_AWAY_HOURS} 小时 / Daily ${MAX_AWAY_HOURS}h away limit reached!*\n\n` +
        `请继续工作 / Please continue working`
      );
    }

    session.status = statusKey; session.awayStart = t;
    session.awayType = statusKey;
    session.breakCounts[statusKey] = currentCount + 1;
    session.log.push({ action: text.trim(), time: t, timeStr: locTime });

    const usedCount   = session.breakCounts[statusKey];
    const remainingMs = Math.max(0, MAX_DAILY_AWAY_MS - session.totalAwayMs);
    send(chatId,
      `${emoji} ${mention} → *${STATUS_LABELS[statusKey]}*\n` +
      `时间 Time: \`${locTime}\` ${COUNTRY}\n` +
      `⏱ 限制 Limit: ${formatDuration(DISPLAY_LIMITS[statusKey])}\n` +
      `📊 今日次数 Today's count: ${usedCount}/${quotaLimit}\n` +
      `🕒 今日剩余离开时间 Away time left: ${formatDuration(remainingMs)}`, true);
    startAwayTimer(userId, chatId, statusKey, mention, session.name);
  }

  // ── BACK TO SEAT ─────────────────────────────────────────────────────────
  else if (text.includes("Back to Seat") || text.includes("Back") || text.includes("回座") || text.includes("Trở lại")) {
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
    const graceLimitMs = AWAY_LIMITS[session.awayType] || 0;
    const dispLimitMs  = DISPLAY_LIMITS[session.awayType] || 0;
    const wasOvertime  = awayDuration >= graceLimitMs;
    const fromBreak    = STATUS_LABELS[session.awayType] || "休息 Break";
    session.status     = "work";
    session.log.push({ action: "回座 Back to Seat", time: t, timeStr: locTime });

    const currentWorkMs = (t - session.workStart) - session.totalAwayMs;

    let msg2 =
      `💺 ${mention} *回座成功 / Back to seat!*\n` +
      `🔙 来自 From: ${fromBreak}\n` +
      `🕐 回座时间 Time: \`${locTime}\` ${COUNTRY}\n` +
      `⏱ 本次离开 This break: \`${formatDuration(awayDuration)}\`\n` +
      `🚶 今日总离开 Total away today: \`${formatDuration(session.totalAwayMs)}\` / ${MAX_AWAY_HOURS}h\n` +
      `⏰ 上班时间 Clock-in: \`${session.clockInTime || "—"}\`\n` +
      `💼 已工作 Worked so far: \`${formatDuration(currentWorkMs)}\``;

    if (wasOvertime) {
      msg2 += `\n\n⚠️ *超时算迟到 / Overtime by ${formatDuration(awayDuration - dispLimitMs)}!*`;
      sendAdmin(
        `🚨 *OVERTIME (Back to Seat)*\n\n` +
        `👤 Staff: ${session.name}\n` +
        `📍 From: ${fromBreak}\n` +
        `⏱ Away: ${formatDuration(awayDuration)} (limit: ${formatDuration(dispLimitMs)})\n` +
        `⚠️ Over by: ${formatDuration(awayDuration - dispLimitMs)}\n` +
        `🕐 ${locTime} ${COUNTRY}`
      );
    }

    if (session.totalAwayMs >= MAX_DAILY_AWAY_MS) {
      msg2 += `\n\n🚫 *今日离开时间已满 ${MAX_AWAY_HOURS} 小时 / ${MAX_AWAY_HOURS}h away limit reached — no more breaks today.*`;
    }

    send(chatId, msg2, true);
  }
});

// ─── ERRORS ────────────────────────────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err.message));
console.log(`✅ Work Check-in Bot is running... (${COUNTRY} UTC+${TZ_OFFSET_HOURS})`);
console.log(`⏰ Report scheduler active — sends daily at ${REPORT_TIME_STR} ${COUNTRY}`);
