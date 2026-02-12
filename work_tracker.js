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
 *   6. 加班不满 1 小时不计为加班
 *
 * Obsidian 同步:
 *   数据按月存储到 ~/Documents/Obsidian/CDX/Overtime/YYYY-MM.md
 * ========================================================
 */

const fs = require('fs');
const path = require('path');

// ==================== 配置区 ====================
const OBSIDIAN_DIR = path.join(require('os').homedir(), 'Documents', 'Obsidian', 'CDX', 'Overtime');
const STATE_FILE = path.join(require('os').homedir(), '.work_start_time');

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

/** 获取今天日期 "YYYY-MM-DD" */
const todayDate = () => new Date().toISOString().split('T')[0];

/** 校验 HH:MM 格式 */
const isValidTime = (t) => /^\d{2}:\d{2}$/.test(t) && toMin(t) >= 0 && toMin(t) < 1440;

/** 校验 YYYY-MM-DD 格式 */
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

/** 校验 YYYY-MM 格式 */
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(m);

// ==================== 常量定义 ====================

const WORK_START     = toMin('08:30');  // 最早上班时间
const FLEX_DEADLINE  = toMin('09:10');  // 弹性打卡截止
const LUNCH_START    = toMin('11:30');  // 午休开始
const LUNCH_END      = toMin('13:00');  // 午休结束
const LUNCH_DURATION = LUNCH_END - LUNCH_START; // 午休时长 = 90分钟
const REQUIRED_WORK  = 450;            // 7.5小时 = 450分钟
const OT_GAP         = 30;             // 正常下班到加班起算之间的间隔（分钟）

// ==================== 核心计算函数 ====================

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

  // 规则5: 满足 7.5h 工作时间所需的下班时间
  // requiredEnd = effStart + 7.5h工作 + 1.5h午休 = effStart + 9h (540min)
  // 但需要判断 effStart 是否在午休之后（虽然实际不太可能）
  let requiredEnd;
  if (effStart < LUNCH_START) {
    // 正常情况：上班时间在午休前
    requiredEnd = effStart + REQUIRED_WORK + LUNCH_DURATION;
  } else if (effStart >= LUNCH_END) {
    // 极端情况：上班在午休之后
    requiredEnd = effStart + REQUIRED_WORK;
  } else {
    // 上班时间在午休期间 → 实际从午休结束开始
    requiredEnd = LUNCH_END + REQUIRED_WORK;
  }

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
  if (outMin > otThreshold) {
    const rawOTMin = outMin - otThreshold;
    const rawOTHours = rawOTMin / 60;

    // 规则6: 不满 1 小时不算加班
    if (rawOTHours >= 1) {
      // 规则4: 按 0.5 小时向下取整
      overtimeHours = Math.floor(rawOTHours * 2) / 2;
    }
  }

  return { workHours, overtimeHours, isLate, notes };
}

// ==================== Obsidian 文件操作 ====================

/** 获取某月 Obsidian 文件路径 */
function getObsidianPath(dateStr) {
  const month = dateStr.slice(0, 7); // "YYYY-MM"
  return path.join(OBSIDIAN_DIR, `${month}.md`);
}

/** Markdown 表头 */
const TABLE_HEADER = [
  '# 加班记录',
  '',
  '| 日期 | 上班 | 下班 | 工作时间(h) | 加班时间(h) | 备注 |',
  '| :---: | :---: | :---: | :---: | :---: | :--- |',
  ''
].join('\n');

/**
 * 写入或更新 Obsidian 记录
 * - 如果该日期已有记录，替换之
 * - 如果没有，追加
 */
function writeToObsidian(dateStr, clockIn, clockOut, result) {
  const filePath = getObsidianPath(dateStr);

  // 确保目录存在
  if (!fs.existsSync(OBSIDIAN_DIR)) {
    fs.mkdirSync(OBSIDIAN_DIR, { recursive: true });
  }

  const noteText = result.notes.length > 0 ? result.notes.map(n => n.replace(/\|/g, '/')).join('; ') : '';
  const newRow = `| ${dateStr} | ${clockIn} | ${clockOut} | ${result.workHours.toFixed(1)} | ${result.overtimeHours.toFixed(1)} | ${noteText} |`;

  if (!fs.existsSync(filePath)) {
    // 文件不存在：创建文件 + 表头 + 数据行
    fs.writeFileSync(filePath, TABLE_HEADER + newRow + '\n');
  } else {
    let content = fs.readFileSync(filePath, 'utf8');
    const datePattern = new RegExp(`^\\| ${dateStr} \\|.*$`, 'm');

    if (datePattern.test(content)) {
      // 该日期已有记录 → 替换
      content = content.replace(datePattern, newRow);
      fs.writeFileSync(filePath, content);
    } else {
      // 追加新行
      fs.appendFileSync(filePath, newRow + '\n');
    }
  }

  return filePath;
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
  if (min > toMin('12:00')) {
    console.warn(`⚠️  注意: 上班时间 ${time} 看起来偏晚，确认是上班打卡吗？`);
  }

  // 保存到状态文件：时间 + 日期
  const data = JSON.stringify({ time, date: todayDate() });
  fs.writeFileSync(STATE_FILE, data);

  console.log(`✅ 上班打卡成功: ${time}`);

  // 显示预计下班信息
  const effStart = Math.max(min, WORK_START);
  let requiredEnd;
  if (effStart < LUNCH_START) {
    requiredEnd = effStart + REQUIRED_WORK + LUNCH_DURATION;
  } else if (effStart >= LUNCH_END) {
    requiredEnd = effStart + REQUIRED_WORK;
  } else {
    requiredEnd = LUNCH_END + REQUIRED_WORK;
  }
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

  let stateData;
  try {
    stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // 兼容旧格式（纯文本时间）
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    stateData = { time: raw, date: todayDate() };
  }

  const clockIn  = stateData.time;
  const dateStr  = stateData.date || todayDate();
  const clockOut = timeArg || nowTime();

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

  // 输出结果
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📅 日期:       ${dateStr}`);
  console.log(`🕐 上班:       ${clockIn}`);
  console.log(`🕕 下班:       ${clockOut}`);
  console.log(`💼 工作时间:   ${result.workHours.toFixed(1)} 小时`);
  console.log(`🔥 加班时间:   ${result.overtimeHours.toFixed(1)} 小时`);
  if (result.notes.length > 0) {
    result.notes.forEach(n => console.log(`   ${n}`));
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 已同步至: ${filePath}`);
  console.log('');

  // 清理状态文件
  fs.unlinkSync(STATE_FILE);
}

/** work status —— 查看今日状态 */
function cmdStatus() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('📋 今日尚未打上班卡');
    console.log('   使用 work in [HH:MM] 打卡');
    return;
  }

  let stateData;
  try {
    stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    stateData = { time: raw, date: todayDate() };
  }

  const clockIn = stateData.time;
  const dateStr = stateData.date || todayDate();
  const min = toMin(clockIn);
  const effStart = Math.max(min, WORK_START);

  // 计算预计时间
  let requiredEnd;
  if (effStart < LUNCH_START) {
    requiredEnd = effStart + REQUIRED_WORK + LUNCH_DURATION;
  } else if (effStart >= LUNCH_END) {
    requiredEnd = effStart + REQUIRED_WORK;
  } else {
    requiredEnd = LUNCH_END + REQUIRED_WORK;
  }
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

  // 输出结果
  console.log('');
  console.log('━━━━━━━ 📝 补录/修正记录 ━━━━━━');
  console.log(`📅 日期:       ${dateStr}`);
  console.log(`🕐 上班:       ${clockIn}`);
  console.log(`🕕 下班:       ${clockOut}`);
  console.log(`💼 工作时间:   ${result.workHours.toFixed(1)} 小时`);
  console.log(`🔥 加班时间:   ${result.overtimeHours.toFixed(1)} 小时`);
  if (result.notes.length > 0) {
    result.notes.forEach(n => console.log(`   ${n}`));
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 已同步至: ${filePath}`);
  console.log('');
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
    const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
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