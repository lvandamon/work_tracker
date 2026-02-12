#!/bin/bash
# ========================================================
#  批量补录/修正打卡记录
# ========================================================
#
# 使用方法:
#   1. 编辑下方 RECORDS 数组，每行格式: "YYYY-MM-DD HH:MM HH:MM"
#   2. 运行: bash batch_fix.sh
#      或:   ./batch_fix.sh        (需先 chmod +x)
#
# 示例:
#   "2026-02-03 08:30 19:00"    表示 2月3日 08:30上班 19:00下班
# ========================================================

WORK_CMD="node /Users/lvandamon/Developer/myWorks/work_tracker/work_tracker.js"

# ====== 在这里填写需要批量补录的记录 ======
RECORDS=(
  "2026-01-21 09:05 19:37"
  "2026-01-22 08:20 18:54"
  "2026-01-23 08:10 17:30"
  "2026-01-26 08:20 18:06"
  "2026-01-28 08:18 20:37"
  "2026-01-29 08:15 21:15"
  "2026-01-30 08:21 21:30"
)
# ==========================================

if [ ${#RECORDS[@]} -eq 0 ]; then
  echo "⚠️  RECORDS 为空，请先编辑 batch_fix.sh 填写打卡记录"
  exit 1
fi

echo ""
echo "━━━━━━━ 批量补录开始 ━━━━━━━"
echo "共 ${#RECORDS[@]} 条记录"
echo ""

SUCCESS=0
FAIL=0

for record in "${RECORDS[@]}"; do
  # 跳过空行和注释行
  [[ -z "$record" || "$record" =~ ^# ]] && continue

  read -r date clock_in clock_out <<< "$record"

  echo "▶ 处理: $date  $clock_in → $clock_out"

  if $WORK_CMD fix "$date" "$clock_in" "$clock_out"; then
    ((SUCCESS++))
  else
    echo "  ❌ 失败: $record"
    ((FAIL++))
  fi
done

echo ""
echo "━━━━━━━ 批量补录完成 ━━━━━━━"
echo "✅ 成功: $SUCCESS 条"
[ $FAIL -gt 0 ] && echo "❌ 失败: $FAIL 条"
echo ""
