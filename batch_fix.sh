#!/bin/bash
# ========================================================
#  批量补录/修正打卡记录
# ========================================================
#
# 使用方法:
#   1. 编辑下方 RECORDS 数组，每行格式: "YYYY-MM-DD HH:MM HH:MM"
#   2. 运行: ./batch_fix.sh
#
# 示例:
#   "2026-02-03 08:30 19:00"    表示 2月3日 08:30上班 19:00下班
# ========================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_CMD="node ${SCRIPT_DIR}/work_tracker.js"

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

# 过滤有效记录
VALID=()
for record in "${RECORDS[@]}"; do
  [[ -z "$record" || "$record" =~ ^# ]] && continue
  VALID+=("$record")
done

if [ ${#VALID[@]} -eq 0 ]; then
  echo "⚠️  RECORDS 为空，请先编辑 batch_fix.sh 填写打卡记录"
  exit 1
fi

# 预览
echo ""
echo "━━━━━━━ 📋 即将补录以下记录 ━━━━━━━"
echo ""
printf "  %-12s  %-6s  %-6s\n" "日期" "上班" "下班"
printf "  %-12s  %-6s  %-6s\n" "----------" "-----" "-----"
for record in "${VALID[@]}"; do
  read -r date clock_in clock_out <<< "$record"
  printf "  %-12s  %-6s  %-6s\n" "$date" "$clock_in" "$clock_out"
done
echo ""
echo "共 ${#VALID[@]} 条记录"
echo ""

# 确认
read -p "确认执行？(y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "已取消"
  exit 0
fi

echo ""
echo "━━━━━━━ 开始补录 ━━━━━━━"
echo ""

SUCCESS=0
FAIL=0

for record in "${VALID[@]}"; do
  read -r date clock_in clock_out <<< "$record"

  echo "▶ $date  $clock_in → $clock_out"

  if $WORK_CMD fix "$date" "$clock_in" "$clock_out" > /dev/null 2>&1; then
    echo "  ✅ 成功"
    ((SUCCESS++))
  else
    echo "  ❌ 失败"
    ((FAIL++))
  fi
done

echo ""
echo "━━━━━━━ 补录完成 ━━━━━━━"
echo "✅ 成功: $SUCCESS 条"
[ $FAIL -gt 0 ] && echo "❌ 失败: $FAIL 条"
echo ""
