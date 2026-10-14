#!/usr/bin/env python3
"""T02155 文本层断言：从生成的 PDF 抽取文本，检查
- 不应出现裸表格分隔符 ` | `（修复前表格是 head.join(' | ') 拼出来的，会残留可见竖线）
- 关键单元格文本（阶段名 / 数值）应存在于文本层（说明表格被渲染而非丢失）
- 引用块 `>` 前缀不应残留
- 图表样本应含柱顶数值文本
"""
import sys
from pypdf import PdfReader

OUT = ".workbuddy"

def text_of(name):
    r = PdfReader(f"{OUT}/{name}")
    return "\n".join((p.extract_text() or "") for p in r.pages)

def main():
    fails = []
    t = text_of("t02155-sample-table.pdf")
    # ① 裸 ` | ` 拼接残留：真实表格现在逐格绘制，文本层不应含 " | "
    if " | " in t or t.count("|") > 0:
        # 允许其它出现？本报告正文无竖线语义；任何竖线都判失败
        fails.append(f"table.pdf 文本层仍含竖线字符（裸 | 拼接残留）：{t.count('|')} 个")
    # ② 关键单元格在文本层
    for cell in ["需求/设计", "开发段", "测试段", "116.5", "74.5%", "直接投入人天"]:
        if cell not in t:
            fails.append(f"table.pdf 缺失关键单元格文本：{cell}")
    # ③ 引用前缀 `>` 不应残留
    if t.strip().startswith(">"):
        fails.append("table.pdf 仍残留引用前缀 '>'")

    c = text_of("t02155-sample-charts.pdf")
    for v in ["14.3", "89.7", "11.9", "74.5"]:
        if v not in c:
            fails.append(f"charts.pdf 缺失柱状图数值文本：{v}")

    if fails:
        print("FAIL")
        for f in fails:
            print(" -", f)
        sys.exit(1)
    print("PASS")

if __name__ == "__main__":
    main()
