#!/usr/bin/env python3
"""把 patches/index-fixes-*.json 依次应用到 personal-site/app/index.html。

大文件（约 66KB）只从 _p2/ 分片拼装，因为直推会被改写个别汉字；零散小改动
用补丁描述更省事：每条补丁只含「找什么 / 换成什么」，单文件 <1.6KB，无损。

每个补丁文件格式（两种都支持）：
    [ { "find": "...", "replace": "...", "probe": "..." } ]
    { "items": [ { ... } ] }

幂等：find 不存在、但 probe（缺省为 replace）已存在 → 视为已应用，跳过；
两者都不存在 → 报错退出，防止静默漏改。
注意：replace 不得包含完整的 find，否则替换后 find 依旧命中，会重复插入。

用法（仓库根目录）：
    python3 scripts/apply_patches.py            # 依次应用并写回
    python3 scripts/apply_patches.py --check    # 只检查，不写文件
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "personal-site" / "app" / "index.html"
PATCH_DIR = ROOT / "patches"
EXPECTED_SIZE = 68398


def load_items(spec) -> list:
    if isinstance(spec, dict):
        return spec.get("items", [])
    return spec


def apply_items(text: str, items: list, label: str) -> str:
    for i, item in enumerate(items):
        find = item["find"]
        repl = item["replace"]
        probe = item.get("probe") or repl
        if find in text:
            text = text.replace(find, repl, 1)
            print(f"  {label}[{i}] 应用 ({len(repl.encode())} B)")
        elif probe in text:
            print(f"  {label}[{i}] 已应用，跳过")
        else:
            raise SystemExit(f"{label}[{i}] find/probe 都不存在，中止")
    return text


def main() -> int:
    if not TARGET.exists():
        raise SystemExit(f"目标不存在: {TARGET}")

    patches = sorted(PATCH_DIR.glob("index-fixes-*.json"))
    if not patches:
        print("没有补丁文件，跳过")
        return 0

    text = TARGET.read_text(encoding="utf-8")
    before = len(text.encode("utf-8"))
    print(f"目标 {TARGET.relative_to(ROOT)}: {before} 字节")
    print(f"补丁 {len(patches)} 个")

    changed = False
    for pf in patches:
        spec = json.loads(pf.read_text(encoding="utf-8"))
        new_text = apply_items(text, load_items(spec), pf.name)
        if new_text != text:
            changed = True
            text = new_text

    after = len(text.encode("utf-8"))
    print(f"结果 {after} 字节（期望 {EXPECTED_SIZE}）")

    if after != EXPECTED_SIZE:
        raise SystemExit(f"字节数不符，拒绝写入（{after} != {EXPECTED_SIZE}）")

    if "--check" in sys.argv:
        print("check 模式，未写文件")
        return 0

    if not changed:
        print("内容无变化")
        return 0

    TARGET.write_bytes(text.encode("utf-8"))
    print(f"已写入 {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
