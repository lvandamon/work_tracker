#!/usr/bin/env node
/**
 * ========================================================
 *  工作时间 & 加班统计工具  v3.0
 * ========================================================
 *
 * 使用方法 (在终端中运行):
 *   work in  [HH:MM]                                上班打卡（可选手动指定时间）
 *   work out [HH:MM] [请假类型]                      下班打卡（可附带请假类型）
 *   work status                                     查看今日打卡状态 & 预计下班时间
 *   work fix  YYYY-MM-DD HH:MM HH:MM [请假类型]      补打 / 修正某天的记录
 *   work leave [YYYY-MM-DD] <请假类型> [HH:MM HH:MM]  请假记录
 *   work summary YYYY-MM                            月度汇总
 *
 * 示例:
 *   work in                   # 使用当前时间打上班卡
 *   work in 08:45             # 手动指定 08:45 上班
 *   work out 19:30            # 手动指定 19:30 下班
 *   work out 15:00 事假        # 下班并标记请假
 *   work status               # 查看今天状态
 *   work fix 2026-02-10 08:30 20:00   # 补录 2月10日 记录
 *   work fix 2026-02-10 08:30 15:00 事假  # 补录并标记请假
 *   work leave 年假            # 今天全天请假
 *   work leave 2026-02-10 年假  # 指定日期全天请假
 *   work leave 事假 08:30 15:00 # 今天半天请假
 *   work summary 2026-02      # 查看 2026年2月 汇总
 *
 * 工时计算规则:
 *   1. 上班时间 8:30-17:30，早于 8:30 按 8:30 计算
 *   2. 午休 11:30-13:00（90分钟）不计为工作时间
 *   3. 加班起算时间 = 正常下班时间 + 30分钟（随弹性打卡后移）
 *   4. 加班时间按 0.5 小时向下取整
 *   5. 弹性打卡 8:30-9:10，超过 9:10 算迟到，但仍需满足 7.5h 工作时长
 *   6. 加班满 0.5 小时即计为加班
 *
 * Obsidian 同步:
 *   数据按月存储到 ~/Documents/Obsidian/CDX/Overtime/YYYY-MM.md
 * ========================================================
 */

const fs = require('fs');
const path = require('path');

// ==================== 配置区：路径 ====================
const OBSIDIAN_DIR = path.join(require('os').homedir(), 'Documents', 'Obsidian', 'CDX', 'Overtime'); // Obsidian 加班记录存储目录
const STATE_FILE   = path.join(__dirname, '.work_start_time'); // 上班打卡状态文件

// ==================== 时间工具函数 ====================

/** 将 "HH:MM" 转为当天的分钟数 */
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** 将分钟数转为 "HH:MM" */
const toTime = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** 获取当前时间 "HH:MM" */
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 获取今天日期 "YYYY-MM-DD"（使用本地时区） */
const todayDate = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** 将 "YYYY-MM-DD" 转为星期几（返回 "一"~"日"） */
const toWeekday = (dateStr) => {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return ['日', '一', '二', '三', '四', '五', '六'][day];
};

/** 校验 HH:MM 格式 */
const isValidTime = (t) => /^\d{2}:\d{2}$/.test(t) && toMin(t) >= 0 && toMin(t) < 1440;

/** 校验 YYYY-MM-DD 格式 */
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

/** 校验 YYYY-MM 格式 */
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(m);

// ==================== 配置区：规则 ====================

// --- 工时规则 ---
const WORK_START     = toMin('08:30');  // 最早上班时间，早于此按此时间计算
const FLEX_DEADLINE  = toMin('09:10');  // 弹性打卡截止，超过算迟到
const LATE_WARN      = toMin('12:00');  // 上班打卡偏晚提醒阈值
const LUNCH_START    = toMin('11:30');  // 午休开始
const LUNCH_END      = toMin('13:00');  // 午休结束
const LUNCH_DURATION = LUNCH_END - LUNCH_START; // 午休时长（派生值，90 分钟）
const REQUIRED_WORK  = 450;            // 每日工作时长：7.5 小时 = 450 分钟

// --- 加班规则 ---
const OT_GAP         = 30;             // 正常下班到加班起算的间隔（分钟）
const OT_MIN_HOURS   = 0.5;            // 加班最低门槛（小时），不足则不计为加班
const OT_HINT_GAP    = 15;             // 提示阈值（分钟），距下一个 0.5h 整点 ≤ 此值时提示

// ==================== 核心计算函数 ====================

/** 全天请假结果（无上下班时间） */
function calcFullDayLeave(leaveType) {
  return {
    workHours: 0,
    overtimeHours: 0,
    leaveHours: REQUIRED_WORK / 60, // 7.5
    leaveType,
    isLate: false,
    notes: [],
    hint: '',
  };
}

/** 根据有效上班时间计算满足 7.5h 工作所需的下班时间 */
function calcRequiredEnd(effStart) {
  if (effStart < LUNCH_START) {
    return effStart + REQUIRED_WORK + LUNCH_DURATION;
  } else if (effStart >= LUNCH_END) {
    return effStart + REQUIRED_WORK;
  } else {
    return LUNCH_END + REQUIRED_WORK;
  }
}

/**
 * 计算工作时间和加班时间
 *
 * @param {string} clockIn  - 上班打卡时间 "HH:MM"
 * @param {string} clockOut - 下班打卡时间 "HH:MM"
 * @returns {{ workHours: number, overtimeHours: number, isLate: boolean, notes: string[] }}
 */
function calcWorktime(clockIn, clockOut, leaveType = '') {
  const notes = [];
  const inMin  = toMin(clockIn);
  const outMin = toMin(clockOut);

  // 规则1: 早于 8:30 按 8:30 计算
  const effStart = Math.max(inMin, WORK_START);

  // 规则5: 弹性打卡检测，超过 9:10 标记迟到
  const isLate = effStart > FLEX_DEADLINE;
  if (isLate) {
    notes.push(`⚠️  迟到！打卡时间 ${clockIn} 超过弹性截止 09:10`);
  }

  const requiredEnd = calcRequiredEnd(effStart);

  // 规则2: 计算实际工作分钟数（扣除午休重叠部分）
  const overlapStart = Math.max(effStart, LUNCH_START);
  const overlapEnd   = Math.min(outMin, LUNCH_END);
  const lunchOverlap = Math.max(0, overlapEnd - overlapStart);

  const actualWorkMin = (outMin - effStart) - lunchOverlap;

  // 工作时间：实际工作分钟数，封顶 7.5h（450分钟）
  const workMin   = Math.min(Math.max(actualWorkMin, 0), REQUIRED_WORK);
  const workHours = workMin / 60;

  // 请假模式：计算请假时长，抑制工时不足警告和加班
  let leaveHours = 0;
  if (leaveType) {
    const deficit = REQUIRED_WORK - workMin; // 分钟
    if (deficit > 0) {
      leaveHours = Math.ceil((deficit / 60) * 2) / 2; // 向上取整到 0.5h
    }
    return { workHours, overtimeHours: 0, leaveHours, leaveType, isLate, notes, hint: '' };
  }

  // 判断是否满足 7.5h 工作时长
  if (actualWorkMin < REQUIRED_WORK) {
    const deficit = REQUIRED_WORK - actualWorkMin;
    notes.push(`⚠️  工作时长不足 7.5h，还差 ${Math.ceil(deficit)} 分钟`);
  }

  // 规则3: 加班起算时间 = 满足7.5h所需下班时间 + 30分钟间隔
  const otThreshold = requiredEnd + OT_GAP;

  // 规则4 & 6: 计算加班时间
  let overtimeHours = 0;
  let hint = '';
  if (outMin > otThreshold) {
    const rawOTMin = outMin - otThreshold;
    const rawOTHours = rawOTMin / 60;

    // 规则6: 满 OT_MIN_HOURS 即算加班
    if (rawOTHours >= OT_MIN_HOURS) {
      // 规则4: 按 0.5 小时向下取整
      overtimeHours = Math.floor(rawOTHours * 2) / 2;
    }

    // 提示：距下一个 0.5h 加班整点 ≤10 分钟
    const nextHalfHour = Math.ceil(rawOTMin / 30) * 30;
    const gap = nextHalfHour - rawOTMin;
    if (gap > 0 && gap <= OT_HINT_GAP) {
      const nextOTHours = (nextHalfHour / 60).toFixed(1);
      hint = `💡 再待 ${gap} 分钟可凑满 ${nextOTHours}h 加班`;
    }
  } else {
    // 还没到加班起算点
    const gap = otThreshold - outMin;
    if (gap > 0 && gap <= OT_HINT_GAP) {
      hint = `💡 再待 ${gap} 分钟开始计算 0.5h 加班`;
    }
  }

  return { workHours, overtimeHours, leaveHours: 0, leaveType: '', isLate, notes, hint };
}

// ==================== Obsidian 文件操作 ====================

/**
 * 解析 Obsidian 表格数据行（兼容新旧格式）
 * 旧格式（7列）: | 日期 | 星期 | 上班 | 下班 | 工时 | 加班 | 备注 |
 * 新格式（8列）: | 日期 | 星期 | 上班 | 下班 | 工时 | 加班 | 请假 | 备注 |
 */
function parseRecordLine(line, hasLeaveColumn) {
  if (hasLeaveColumn) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(?:\s*周[^\|]*\|)?\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)[^|]*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|$/);
    if (!m) return null;
    let leave = 0, leaveType = '';
    if (m[6].trim()) {
      const lm = m[6].match(/([\d.]+)\s*(?:🏖\s*)?(\S*)/);
      if (lm) { leave = parseFloat(lm[1]) || 0; leaveType = lm[2] || ''; }
    }
    return { date: m[1], inTime: m[2], outTime: m[3], work: parseFloat(m[4]), ot: parseFloat(m[5]), leave, leaveType, note: m[7].trim() };
  }
  // 旧格式：无请假列
  const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(?:\s*周[^\|]*\|)?\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)[^|]*\|\s*(.*?)\s*\|$/);
  if (!m) return null;
  return { date: m[1], inTime: m[2], outTime: m[3], work: parseFloat(m[4]), ot: parseFloat(m[5]), leave: 0, leaveType: '', note: m[6].trim() };
}

/** 检测 Obsidian 文件是否包含请假列 */
function detectLeaveColumn(lines) {
  for (const line of lines) {
    if (line.includes('请假') && line.startsWith('|')) return true;
  }
  return false;
}

/** 获取某月 Obsidian 文件路径 */
function getObsidianPath(dateStr) {
  const month = dateStr.slice(0, 7); // "YYYY-MM"
  return path.join(OBSIDIAN_DIR, `${month}.md`);
}

/**
 * 写入或更新 Obsidian 记录
 * 每次写入时重建完整文件：解析已有数据 → 更新/追加 → 按日期排序 → 生成 markdown
 */
function writeToObsidian(dateStr, clockIn, clockOut, result) {
  const filePath = getObsidianPath(dateStr);

  // 确保目录存在
  if (!fs.existsSync(OBSIDIAN_DIR)) {
    fs.mkdirSync(OBSIDIAN_DIR, { recursive: true });
  }

  // 解析已有记录
  const records = new Map();
  if (fs.existsSync(filePath)) {
    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
    const hasLeave = detectLeaveColumn(fileLines);
    for (const line of fileLines) {
      const r = parseRecordLine(line, hasLeave);
      if (r) records.set(r.date, r);
    }
  }

  // 更新或追加当前记录
  const noteText = result.notes.length > 0 ? result.notes.map(n => n.replace(/\|/g, '／')).join('; ') : '';
  records.set(dateStr, {
    date: dateStr, inTime: clockIn, outTime: clockOut,
    work: result.workHours, ot: result.overtimeHours,
    leave: result.leaveHours || 0, leaveType: result.leaveType || '',
    note: noteText,
  });

  // 按日期排序
  const sorted = [...records.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 汇总统计
  let totalWork = 0, totalOT = 0, totalLeave = 0, lateDays = 0;
  const leaveByType = {};
  for (const r of sorted) {
    totalWork += r.work;
    totalOT += r.ot;
    totalLeave += r.leave || 0;
    if (r.leaveType) {
      leaveByType[r.leaveType] = (leaveByType[r.leaveType] || 0) + (r.leave || 0);
    }
    if (r.note.includes('迟到')) lateDays++;
  }

  // 生成 markdown
  const month = dateStr.slice(0, 7);
  const lines = [];
  lines.push(`# ${month} 加班记录`);
  lines.push('');
  lines.push('| 日期 | 星期 | 上班 | 下班 | 工时 | 加班 | 请假 | 备注 |');
  lines.push('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');
  for (const r of sorted) {
    const otMark = r.ot > 0 ? ` 🔥` : '';
    const leaveMark = (r.leave || 0) > 0 ? ` 🏖 ${r.leaveType || ''}` : '';
    lines.push(`| ${r.date} | 周${toWeekday(r.date)} | ${r.inTime} | ${r.outTime} | ${r.work.toFixed(1)} | ${r.ot.toFixed(1)}${otMark} | ${(r.leave || 0).toFixed(1)}${leaveMark} | ${r.note} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  let leaveSuffix = '';
  if (totalLeave > 0) {
    const typeDetail = Object.entries(leaveByType).map(([t, h]) => `${t} ${h.toFixed(1)}h`).join('、');
    leaveSuffix = ` ｜ 请假 ${totalLeave.toFixed(1)}h（${typeDetail}）`;
  }
  lines.push(`> **出勤 ${sorted.length} 天 ｜ 工时 ${totalWork.toFixed(1)}h ｜ 加班 ${totalOT.toFixed(1)}h${leaveSuffix}**${lateDays > 0 ? ` ｜ 迟到 ${lateDays} 次` : ''}`);
  lines.push('');

  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

// ==================== 公共辅助 ====================

/** 读取上班打卡状态文件（兼容旧纯文本格式） */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    return { time: raw, date: todayDate() };
  }
}

/** 输出打卡结果 */
function printResult(title, dateStr, clockIn, clockOut, result, filePath) {
  console.log('');
  console.log(`━━━━━━━ ${title} ━━━━━━`);
  console.log(`📅 日期:       ${dateStr} 周${toWeekday(dateStr)}`);
  console.log(`🕐 上班:       ${clockIn}`);
  console.log(`🕕 下班:       ${clockOut}`);
  console.log(`💼 工作时间:   ${result.workHours.toFixed(1)} 小时`);
  console.log(`🔥 加班时间:   ${result.overtimeHours.toFixed(1)} 小时`);
  if (result.leaveHours > 0) {
    console.log(`🏖 请假时间:   ${result.leaveHours.toFixed(1)} 小时 (${result.leaveType})`);
  }
  if (result.notes.length > 0) {
    result.notes.forEach(n => console.log(`   ${n}`));
  }
  if (result.hint) {
    console.log(`${result.hint}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 已同步至: ${filePath}`);
  console.log('');
}

// ==================== 命令实现 ====================

/** work in [HH:MM] —— 上班打卡 */
function cmdIn(timeArg) {
  const time = timeArg || nowTime();

  if (!isValidTime(time)) {
    console.error(`❌ 无效的时间格式: "${timeArg}"，请使用 HH:MM 格式`);
    process.exit(1);
  }

  const min = toMin(time);
  if (min > LATE_WARN) {
    console.warn(`⚠️  注意: 上班时间 ${time} 看起来偏晚，确认是上班打卡吗？`);
  }

  // 保存到状态文件：时间 + 日期
  const data = JSON.stringify({ time, date: todayDate() });
  fs.writeFileSync(STATE_FILE, data);

  console.log(`✅ 上班打卡成功: ${time}`);

  // 显示预计下班信息
  const effStart = Math.max(min, WORK_START);
  const requiredEnd = calcRequiredEnd(effStart);
  const otThreshold = requiredEnd + OT_GAP;

  console.log(`📋 预计正常下班: ${toTime(requiredEnd)}`);
  console.log(`⏰ 加班起算时间: ${toTime(otThreshold)}`);

  if (effStart > FLEX_DEADLINE) {
    console.log(`⚠️  迟到！超过弹性截止时间 09:10`);
  }
}

/** work out [HH:MM] [请假类型] —— 下班打卡 */
function cmdOut(timeArg, leaveType) {
  if (!fs.existsSync(STATE_FILE)) {
    console.error('❌ 找不到上班记录，请先执行 work in');
    process.exit(1);
  }

  const stateData = readState();
  const clockIn  = stateData.time;
  const dateStr  = stateData.date || todayDate();
  const clockOut = timeArg || nowTime();

  // 检测过期状态
  if (dateStr !== todayDate()) {
    console.warn(`⚠️  上班记录是 ${dateStr} 的，今天是 ${todayDate()}`);
    console.warn('   请使用 work fix 补录，或 work in 重新打卡');
    process.exit(1);
  }

  if (!isValidTime(clockOut)) {
    console.error(`❌ 无效的时间格式: "${timeArg}"，请使用 HH:MM 格式`);
    process.exit(1);
  }

  if (toMin(clockOut) <= toMin(clockIn)) {
    console.error(`❌ 下班时间 ${clockOut} 不能早于或等于上班时间 ${clockIn}`);
    process.exit(1);
  }

  // 计算工时
  const result = calcWorktime(clockIn, clockOut, leaveType || '');

  // 同步到 Obsidian
  const filePath = writeToObsidian(dateStr, clockIn, clockOut, result);

  const title = leaveType ? '🏖 下班打卡（请假）' : '🕕 下班打卡';
  printResult(title, dateStr, clockIn, clockOut, result, filePath);
}

/** work status —— 查看今日状态 */
function cmdStatus() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('📋 今日尚未打上班卡');
    console.log('   使用 work in [HH:MM] 打卡');
    return;
  }

  const stateData = readState();
  const clockIn = stateData.time;
  const dateStr = stateData.date || todayDate();

  // 检测过期状态（昨天打卡忘记下班）
  if (dateStr !== todayDate()) {
    console.log(`⚠️  检测到 ${dateStr} 的上班记录，但今天是 ${todayDate()}`);
    console.log('   可能昨天忘记下班打卡，请使用:');
    console.log(`   work fix ${dateStr} ${clockIn} HH:MM  补录昨天下班`);
    console.log('   work in                          重新打今天上班卡');
    return;
  }

  const min = toMin(clockIn);
  const effStart = Math.max(min, WORK_START);

  const requiredEnd = calcRequiredEnd(effStart);
  const otThreshold = requiredEnd + OT_GAP;

  const currentMin = toMin(nowTime());
  const isWorking = currentMin >= effStart;

  console.log('');
  console.log('━━━━━━━ 📋 今日工作状态 ━━━━━━━');
  console.log(`📅 日期:         ${dateStr} 周${toWeekday(dateStr)}`);
  console.log(`🕐 上班打卡:     ${clockIn}`);
  console.log(`🏁 满足7.5h下班: ${toTime(requiredEnd)}`);
  console.log(`⏰ 加班起算时间: ${toTime(otThreshold)}`);

  if (effStart > FLEX_DEADLINE) {
    console.log(`⚠️  迟到！超过弹性截止时间 09:10`);
  }

  // 如果现在还在上班，模拟计算当前已工作时间
  if (isWorking) {
    const simResult = calcWorktime(clockIn, nowTime());
    console.log(`⏱️  已工作:       ${simResult.workHours.toFixed(1)} 小时`);
    if (currentMin > otThreshold) {
      console.log(`🔥 已加班:       ${simResult.overtimeHours.toFixed(1)} 小时`);
    } else if (currentMin > requiredEnd) {
      const remainToOT = otThreshold - currentMin;
      if (remainToOT > 0) {
        console.log(`⏳ 距加班起算:   还有 ${remainToOT} 分钟`);
      }
    } else {
      const remainToEnd = requiredEnd - currentMin;
      console.log(`⏳ 距正常下班:   还有 ${remainToEnd} 分钟`);
    }
    if (simResult.hint) {
      console.log(`${simResult.hint}`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

/** work leave [YYYY-MM-DD] <类型> [HH:MM HH:MM] —— 请假记录 */
function cmdLeave(args) {
  let dateStr, leaveType, clockIn, clockOut;

  // 判断第一个参数是日期还是请假类型
  if (args[0] && isValidDate(args[0])) {
    dateStr   = args[0];
    leaveType = args[1];
    clockIn   = args[2];
    clockOut  = args[3];
  } else {
    dateStr   = todayDate();
    leaveType = args[0];
    clockIn   = args[1];
    clockOut  = args[2];
  }

  if (!leaveType) {
    console.error('❌ 用法: work leave [YYYY-MM-DD] <请假类型> [HH:MM HH:MM]');
    console.error('   示例: work leave 年假                    # 今天全天请假');
    console.error('         work leave 2026-02-24 事假          # 指定日期全天请假');
    console.error('         work leave 事假 08:30 15:00         # 今天半天请假');
    console.error('         work leave 2026-02-24 事假 08:30 15:00');
    process.exit(1);
  }

  let result;
  if (clockIn && clockOut) {
    // 半天请假：有上下班时间
    if (!isValidTime(clockIn)) {
      console.error(`❌ 无效的上班时间: "${clockIn}"，请使用 HH:MM`);
      process.exit(1);
    }
    if (!isValidTime(clockOut)) {
      console.error(`❌ 无效的下班时间: "${clockOut}"，请使用 HH:MM`);
      process.exit(1);
    }
    if (toMin(clockOut) <= toMin(clockIn)) {
      console.error(`❌ 下班时间 ${clockOut} 不能早于或等于上班时间 ${clockIn}`);
      process.exit(1);
    }
    result = calcWorktime(clockIn, clockOut, leaveType);
  } else if (!clockIn && !clockOut) {
    // 全天请假：无上下班时间
    clockIn  = '--';
    clockOut = '--';
    result = calcFullDayLeave(leaveType);
  } else {
    console.error('❌ 半天请假需同时提供上班和下班时间');
    process.exit(1);
  }

  const filePath = writeToObsidian(dateStr, clockIn, clockOut, result);
  printResult('🏖 请假记录', dateStr, clockIn, clockOut, result, filePath);
}

/** work fix YYYY-MM-DD HH:MM HH:MM [请假类型] —— 补打/修正记录 */
function cmdFix(dateStr, clockIn, clockOut, leaveType) {
  // 参数校验
  if (!dateStr || !clockIn || !clockOut) {
    console.error('❌ 用法: work fix YYYY-MM-DD HH:MM HH:MM [请假类型]');
    console.error('   示例: work fix 2026-02-10 08:30 20:00');
    console.error('         work fix 2026-02-10 08:30 15:00 事假');
    process.exit(1);
  }

  if (!isValidDate(dateStr)) {
    console.error(`❌ 无效的日期格式: "${dateStr}"，请使用 YYYY-MM-DD`);
    process.exit(1);
  }

  if (!isValidTime(clockIn)) {
    console.error(`❌ 无效的上班时间: "${clockIn}"，请使用 HH:MM`);
    process.exit(1);
  }

  if (!isValidTime(clockOut)) {
    console.error(`❌ 无效的下班时间: "${clockOut}"，请使用 HH:MM`);
    process.exit(1);
  }

  if (toMin(clockOut) <= toMin(clockIn)) {
    console.error(`❌ 下班时间 ${clockOut} 不能早于或等于上班时间 ${clockIn}`);
    process.exit(1);
  }

  // 计算工时
  const result = calcWorktime(clockIn, clockOut, leaveType || '');

  // 同步到 Obsidian
  const filePath = writeToObsidian(dateStr, clockIn, clockOut, result);

  const title = leaveType ? '📝 补录/修正记录（请假）' : '📝 补录/修正记录';
  printResult(title, dateStr, clockIn, clockOut, result, filePath);
}

/** work summary YYYY-MM —— 月度汇总 */
function cmdSummary(monthStr) {
  if (!monthStr) {
    // 默认当前月份
    monthStr = todayDate().slice(0, 7);
  }

  if (!isValidMonth(monthStr)) {
    console.error(`❌ 无效的月份格式: "${monthStr}"，请使用 YYYY-MM`);
    process.exit(1);
  }

  const filePath = path.join(OBSIDIAN_DIR, `${monthStr}.md`);

  if (!fs.existsSync(filePath)) {
    console.log(`📋 ${monthStr} 暂无加班记录`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // 解析表格数据行（跳过表头和分隔线）
  const hasLeave = detectLeaveColumn(lines);
  const dataRows = [];
  let totalWork = 0;
  let totalOT = 0;
  let totalLeave = 0;
  let totalDays = 0;
  let lateDays = 0;
  const leaveByType = {};

  for (const line of lines) {
    const r = parseRecordLine(line, hasLeave);
    if (r) {
      dataRows.push(r);
      totalWork += r.work;
      totalOT   += r.ot;
      totalLeave += r.leave || 0;
      totalDays++;
      if (r.note.includes('迟到')) lateDays++;
      if (r.leaveType) {
        leaveByType[r.leaveType] = (leaveByType[r.leaveType] || 0) + (r.leave || 0);
      }
    }
  }

  if (dataRows.length === 0) {
    console.log(`📋 ${monthStr} 暂无有效记录`);
    return;
  }

  // 按日期排序
  dataRows.sort((a, b) => a.date.localeCompare(b.date));

  // 输出汇总
  console.log('');
  console.log(`━━━━━━━ 📊 ${monthStr} 月度汇总 ━━━━━━━`);
  console.log('');

  // 逐日详情
  console.log('| 日期          | 上班  | 下班  | 工作(h) | 加班(h) | 请假(h) |');
  console.log('| :-----------: | :---: | :---: | :-----: | :-----: | :-----: |');
  for (const row of dataRows) {
    const otDisplay = row.ot > 0 ? `${row.ot.toFixed(1)} 🔥` : row.ot.toFixed(1);
    const leaveDisplay = (row.leave || 0) > 0 ? `${row.leave.toFixed(1)} 🏖 ${row.leaveType || ''}` : (row.leave || 0).toFixed(1);
    console.log(`| ${row.date} 周${toWeekday(row.date)} | ${row.inTime} | ${row.outTime} | ${row.work.toFixed(1)}    | ${otDisplay}    | ${leaveDisplay}    |`);
  }

  console.log('');
  console.log(`📅 出勤天数:     ${totalDays} 天`);
  console.log(`💼 总工作时间:   ${totalWork.toFixed(1)} 小时`);
  console.log(`🔥 总加班时间:   ${totalOT.toFixed(1)} 小时`);
  if (totalLeave > 0) {
    console.log(`🏖 总请假时间:   ${totalLeave.toFixed(1)} 小时`);
    for (const [type, hours] of Object.entries(leaveByType)) {
      console.log(`   ${type}: ${hours.toFixed(1)} 小时`);
    }
  }
  if (lateDays > 0) {
    console.log(`⚠️  迟到次数:     ${lateDays} 次`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

// ==================== 主入口 ====================

const [,, action, ...args] = process.argv;

switch (action) {
  case 'in':
    cmdIn(args[0]);
    break;
  case 'out':
    cmdOut(args[0], args[1]);
    break;
  case 'status':
    cmdStatus();
    break;
  case 'fix':
    cmdFix(args[0], args[1], args[2], args[3]);
    break;
  case 'leave':
    cmdLeave(args);
    break;
  case 'summary':
    cmdSummary(args[0]);
    break;
  default:
    console.log(`
📖 工作时间 & 加班统计工具 v3.0

用法:
  work in  [HH:MM]                              上班打卡
  work out [HH:MM] [请假类型]                    下班打卡（可附带请假）
  work status                                   查看今日状态
  work fix  YYYY-MM-DD HH:MM HH:MM [请假类型]    补打/修正某天记录
  work leave [YYYY-MM-DD] <请假类型> [HH:MM HH:MM]  请假记录
  work summary [YYYY-MM]                        月度汇总

示例:
  work in                            使用当前时间打卡
  work in 08:45                      手动指定上班时间
  work out 19:30                     手动指定下班时间
  work out 15:00 事假                下班并标记请假
  work fix 2026-02-10 08:30 20:00    修正某天记录
  work fix 2026-02-10 08:30 15:00 事假  修正记录并标记请假
  work leave 年假                    今天全天请假
  work leave 2026-02-10 年假          指定日期全天请假
  work leave 事假 08:30 15:00         今天半天请假
  work leave 2026-02-10 事假 08:30 15:00  指定日期半天请假
  work summary 2026-02               查看2026年2月汇总
`);
    break;
}