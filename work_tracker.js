#!/usr/bin/env node
/**
 * ========================================================
 *  工作时间 & 加班统计工具  v2.0
 * ========================================================
 *
 * 使用方法 (在终端中运行):
 *   work in  [HH:MM]                     上班打卡（可选手动指定时间）
 *   work out [HH:MM]                     下班打卡（可选手动指定时间）
 *   work status                          查看今日打卡状态 & 预计下班时间
 *   work fix  YYYY-MM-DD HH:MM HH:MM    补打 / 修正某天的记录
 *   work summary YYYY-MM                 月度加班汇总
 *
 * 示例:
 *   work in                   # 使用当前时间打上班卡
 *   work in 08:45             # 手动指定 08:45 上班
 *   work out 19:30            # 手动指定 19:30 下班
 *   work status               # 查看今天状态
 *   work fix 2026-02-10 08:30 20:00   # 补录 2月10日 记录
 *   work summary 2026-02      # 查看 2026年2月 加班汇总
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
function calcWorktime(clockIn, clockOut) {
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

  return { workHours, overtimeHours, isLate, notes, hint };
}

// ==================== Obsidian 文件操作 ====================

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
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)[^|]*\|\s*(.*?)\s*\|$/);
      if (m) {
        records.set(m[1], { date: m[1], inTime: m[2], outTime: m[3], work: parseFloat(m[4]), ot: parseFloat(m[5]), note: m[6].trim() });
      }
    }
  }

  // 更新或追加当前记录
  const noteText = result.notes.length > 0 ? result.notes.map(n => n.replace(/\|/g, '／')).join('; ') : '';
  records.set(dateStr, { date: dateStr, inTime: clockIn, outTime: clockOut, work: result.workHours, ot: result.overtimeHours, note: noteText });

  // 按日期排序
  const sorted = [...records.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 汇总统计
  let totalWork = 0, totalOT = 0, lateDays = 0;
  for (const r of sorted) {
    totalWork += r.work;
    totalOT += r.ot;
    if (r.note.includes('迟到')) lateDays++;
  }

  // 生成 markdown
  const month = dateStr.slice(0, 7);
  const lines = [];
  lines.push(`# ${month} 加班记录`);
  lines.push('');
  lines.push('| 日期 | 上班 | 下班 | 工时 | 加班 | 备注 |');
  lines.push('| :---: | :---: | :---: | :---: | :---: | :--- |');
  for (const r of sorted) {
    const otMark = r.ot > 0 ? ` 🔥` : '';
    lines.push(`| ${r.date} | ${r.inTime} | ${r.outTime} | ${r.work.toFixed(1)} | ${r.ot.toFixed(1)}${otMark} | ${r.note} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`> **出勤 ${sorted.length} 天 ｜ 工时 ${totalWork.toFixed(1)}h ｜ 加班 ${totalOT.toFixed(1)}h**${lateDays > 0 ? ` ｜ 迟到 ${lateDays} 次` : ''}`);
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
  console.log(`📅 日期:       ${dateStr}`);
  console.log(`🕐 上班:       ${clockIn}`);
  console.log(`🕕 下班:       ${clockOut}`);
  console.log(`💼 工作时间:   ${result.workHours.toFixed(1)} 小时`);
  console.log(`🔥 加班时间:   ${result.overtimeHours.toFixed(1)} 小时`);
  if (result.notes.length > 0) {
    result.notes.forEach(n => console.log(`   ${n}`));
  }
  if (result.hint) {
    console.log(`   ${result.hint}`);
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

/** work out [HH:MM] —— 下班打卡 */
function cmdOut(timeArg) {
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
  const result = calcWorktime(clockIn, clockOut);

  // 同步到 Obsidian
  const filePath = writeToObsidian(dateStr, clockIn, clockOut, result);

  printResult('🕕 下班打卡', dateStr, clockIn, clockOut, result, filePath);
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
  console.log(`📅 日期:         ${dateStr}`);
  console.log(`🕐 上班打卡:     ${clockIn}`);
  console.log(`🏁 满足7.5h下班: ${toTime(requiredEnd)}`);
  console.log(`⏰ 加班起算时间:  ${toTime(otThreshold)}`);

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
      console.log(`   ${simResult.hint}`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

/** work fix YYYY-MM-DD HH:MM HH:MM —— 补打/修正记录 */
function cmdFix(dateStr, clockIn, clockOut) {
  // 参数校验
  if (!dateStr || !clockIn || !clockOut) {
    console.error('❌ 用法: work fix YYYY-MM-DD HH:MM HH:MM');
    console.error('   示例: work fix 2026-02-10 08:30 20:00');
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
  const result = calcWorktime(clockIn, clockOut);

  // 同步到 Obsidian
  const filePath = writeToObsidian(dateStr, clockIn, clockOut, result);

  printResult('📝 补录/修正记录', dateStr, clockIn, clockOut, result, filePath);
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
  const dataRows = [];
  let totalWork = 0;
  let totalOT = 0;
  let totalDays = 0;
  let lateDays = 0;

  for (const line of lines) {
    // 匹配数据行: | 2026-02-10 | 08:30 | 19:00 | 7.5 | 1.0 | ... |
    const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)[^|]*\|/);
    if (match) {
      const [, date, inTime, outTime, work, ot] = match;
      const workH = parseFloat(work);
      const otH   = parseFloat(ot);
      dataRows.push({ date, inTime, outTime, workH, otH });
      totalWork += workH;
      totalOT   += otH;
      totalDays++;
      if (line.includes('迟到')) lateDays++;
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
  console.log('| 日期       | 上班  | 下班  | 工作(h) | 加班(h) |');
  console.log('| :--------: | :---: | :---: | :-----: | :-----: |');
  for (const row of dataRows) {
    const otDisplay = row.otH > 0 ? `${row.otH.toFixed(1)} 🔥` : row.otH.toFixed(1);
    console.log(`| ${row.date} | ${row.inTime} | ${row.outTime} | ${row.workH.toFixed(1)}    | ${otDisplay}    |`);
  }

  console.log('');
  console.log(`📅 出勤天数:     ${totalDays} 天`);
  console.log(`💼 总工作时间:   ${totalWork.toFixed(1)} 小时`);
  console.log(`🔥 总加班时间:   ${totalOT.toFixed(1)} 小时`);
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
    cmdOut(args[0]);
    break;
  case 'status':
    cmdStatus();
    break;
  case 'fix':
    cmdFix(args[0], args[1], args[2]);
    break;
  case 'summary':
    cmdSummary(args[0]);
    break;
  default:
    console.log(`
📖 工作时间 & 加班统计工具 v2.0

用法:
  work in  [HH:MM]                   上班打卡
  work out [HH:MM]                   下班打卡
  work status                        查看今日状态
  work fix  YYYY-MM-DD HH:MM HH:MM  补打/修正某天记录
  work summary [YYYY-MM]             月度加班汇总

示例:
  work in                  使用当前时间打卡
  work in 08:45            手动指定上班时间
  work out 19:30           手动指定下班时间
  work fix 2026-02-10 08:30 20:00
  work summary 2026-02
`);
    break;
}