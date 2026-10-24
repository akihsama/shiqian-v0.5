#!/usr/bin/env python3
"""把 _p2/ 下的分片还原成 personal-site/app/index.html。

用法（仓库根目录）：
    python3 scripts/assemble_index.py          # 还原并校验
    python3 scripts/assemble_index.py --check  # 只校验，不写文件

分片规则：_p2/p000.txt … p042.txt，另加 p021a/p021b、p022a/p022b 四个半片
（p021、p022 因内容密度过高曾被 GitHub 接口改写个别汉字，故拆半）。
拼装方式：按文件名排序后 b'\\n'.join(各片字节)，末片自带结尾换行。
预期产物：65277 字节。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "_p2"
OUT = ROOT / "personal-site" / "app" / "index.html"
EXPECTED_SIZE = 65277

# 显式顺序表，避免 p021/p021a/p021b 排序歧义
ORDER = (
    [f"p{i:03d}.txt" for i in range(0, 21)]
    + ["p021a.txt", "p021b.txt", "p022a.txt", "p022b.txt"]
    + [f"p{i:03d}.txt" for i in range(23, 43)]
)


def assemble() -> bytes:
    missing = [name for name in ORDER if not (SRC_DIR / name).exists()]
    if missing:
        raise SystemExit(f"缺少分片: {', '.join(missing)}")
    extra = sorted(set(p.name for p in SRC_DIR.glob("*.txt")) - set(ORDER))
    if extra:
        raise SystemExit(f"_p2/ 下有未列入 ORDER 的文件: {', '.join(extra)}")
    return b"\n".join((SRC_DIR / name).read_bytes() for name in ORDER)


def main() -> int:
    data = assemble()
    ok = len(data) == EXPECTED_SIZE
    print(f"拼装结果: {len(data)} 字节 (期望 {EXPECTED_SIZE}) -> {'OK' if ok else 'FAIL'}")
    if not ok:
        return 1

    if "--check" in sys.argv:
        if OUT.exists():
            same = OUT.read_bytes() == data
            print(f"与现有 {OUT.relative_to(ROOT)} 对比: {'一致' if same else '不一致'}")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"已写入: {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
