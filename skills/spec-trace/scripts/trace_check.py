#!/usr/bin/env python3
"""trace_check.py — 查需求书、设计书、计划书之间对不对得上。

只管文档阶段：读 trace.json，报告三份文档之间的漏洞。不运行任何证据，
不判断交付结果——那是 spec-accept 的事。

用法：
  trace_check.py <trace.json> [--cwd <文档路径相对的目录>]

只用标准库。退出码：0 = 对得上；1 = 有漏洞；2 = 用法或文件错误。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any

# 不可能失败的命令。写成证据，等于没有证据。
TRIVIAL = re.compile(r"^\s*(true|:|exit\s+0|echo\b[^|&;]*|printf\b[^|&;]*)\s*$")

# 证据量到哪一层。数字越大越接近人实际用到的东西。
LEVELS = {"logic": 1, "interface": 2, "ui": 3}
LEVEL_WORDS = {"logic": "逻辑层", "interface": "接口层", "ui": "界面层"}

RUNNER = "python3 ~/.agents/skills/spec-accept/scripts/run_evidence.py"


def load(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        print(f"找不到文件：{path}", file=sys.stderr)
        sys.exit(2)
    except json.JSONDecodeError as error:
        print(f"{path} 不是合法的 JSON：{error}", file=sys.stderr)
        sys.exit(2)


def duplicates(ids: list[Any]) -> list[Any]:
    seen: set[Any] = set()
    twice: list[Any] = []
    for one in ids:
        if one in seen and one not in twice:
            twice.append(one)
        seen.add(one)
    return twice


def check_evidence(rid: str, requirement: dict[str, Any], problems: list[str]) -> None:
    """一条需求的端、层级和证据。"""
    surfaces = requirement.get("surfaces") or []
    if not surfaces:
        problems.append(f"需求「{rid}」没有写它落在哪些端（surfaces）：不知道该量哪里。")
    required: dict[str, str] = {}
    for surface in surfaces:
        name = str(surface.get("name", "")).strip() if isinstance(surface, dict) else ""
        level = str(surface.get("level", "")).strip() if isinstance(surface, dict) else ""
        if name == "":
            problems.append(f"需求「{rid}」的 surfaces 里有一项没有 name。写成 {{\"name\": \"web\", \"level\": \"ui\"}}。")
            continue
        if level not in LEVELS:
            problems.append(f"需求「{rid}」的端「{name}」层级是「{level}」，只能是 logic、interface 或 ui。")
            continue
        required[name] = level

    reached: dict[str, int] = {}
    for evidence in requirement.get("evidence") or []:
        eid = evidence.get("id")
        command = str(evidence.get("run", "")).strip()
        if command == "":
            problems.append(f"证据「{eid}」（需求 {rid}）没有命令。「已确认」「见截图」不是证据。")
        elif TRIVIAL.match(command):
            problems.append(f"证据「{eid}」（需求 {rid}）的命令不可能失败：{command}")
        if not str(evidence.get("failsWhen", "")).strip():
            problems.append(
                f"证据「{eid}」（需求 {rid}）没写什么情况下会失败（failsWhen）。写不出来，多半是它没量到东西。"
            )
        surface = str(evidence.get("surface", "")).strip()
        level = str(evidence.get("level", "")).strip()
        if level not in LEVELS:
            problems.append(f"证据「{eid}」（需求 {rid}）的层级是「{level}」，只能是 logic、interface 或 ui。")
            continue
        if surface not in required:
            problems.append(
                f"证据「{eid}」（需求 {rid}）量的端是「{surface}」，不在这条需求的端里"
                f"（{', '.join(required) or '还没填'}）。"
            )
            continue
        reached[surface] = max(reached.get(surface, 0), LEVELS[level])

    for name, level in required.items():
        got = reached.get(name, 0)
        if got == 0:
            problems.append(f"需求「{rid}」在「{name}」这一端没有证据：这一端做没做到无法证明。")
        elif got < LEVELS[level]:
            have = next(word for key, word in LEVEL_WORDS.items() if LEVELS[key] == got)
            problems.append(
                f"需求「{rid}」在「{name}」这一端要量到{LEVEL_WORDS[level]}，现有证据最高只到{have}："
                f"它证明不了这条需求在{LEVEL_WORDS[level]}成立。"
            )


def check_structure(trace: dict[str, Any], base: str) -> list[str]:
    """返回漏洞列表。空列表 = 三份文档对得上。"""
    problems: list[str] = []
    requirements = trace.get("requirements") or []
    tasks = trace.get("tasks") or []
    batches = trace.get("batches") or []
    leftovers = trace.get("leftovers") or []

    if not requirements:
        problems.append("requirements 是空的：没有需求，就没有东西可以追溯。")

    for kind, rows in (("需求", requirements), ("任务", tasks), ("批次", batches), ("遗留项", leftovers)):
        missing = [index for index, row in enumerate(rows) if not str(row.get("id", "")).strip()]
        if missing:
            problems.append(f"{kind}表第 {', '.join(str(i + 1) for i in missing)} 行没有 id。")
        for repeated in duplicates([row.get("id") for row in rows if row.get("id")]):
            problems.append(f"{kind}编号「{repeated}」出现了不止一次。")

    requirement_by_id = {row.get("id"): row for row in requirements}
    task_by_id = {row.get("id"): row for row in tasks}
    batch_ids = {row.get("id") for row in batches}

    evidence_owner: dict[str, str] = {}
    for requirement in requirements:
        for evidence in requirement.get("evidence") or []:
            eid = evidence.get("id")
            if not eid:
                problems.append(f"需求「{requirement.get('id')}」有一条证据没有 id。")
                continue
            if eid in evidence_owner:
                problems.append(f"证据编号「{eid}」出现了不止一次。")
            evidence_owner[eid] = requirement.get("id")

    for requirement in requirements:
        rid = requirement.get("id")
        status = requirement.get("status", "active")
        if status == "deferred":
            deferral = requirement.get("deferral") or {}
            lacking = [key for key in ("approvedBy", "on", "reason") if not str(deferral.get(key, "")).strip()]
            if lacking:
                problems.append(
                    f"需求「{rid}」被推迟，但没有批准记录（缺 {', '.join(lacking)}）。"
                    "推迟一条需求要由需求所有者决定。"
                )
            continue
        if status != "active":
            problems.append(f"需求「{rid}」的 status 是「{status}」，只能是 active 或 deferred。")
            continue
        if not requirement.get("design"):
            problems.append(f"需求「{rid}」没有设计出处：设计书里漏了它，或者没登记。")
        if not requirement.get("tasks"):
            problems.append(f"需求「{rid}」没有任务：写了，但没有人做。")
        for task_id in requirement.get("tasks") or []:
            task = task_by_id.get(task_id)
            if task is None:
                problems.append(f"需求「{rid}」指向任务「{task_id}」，任务表里没有它。")
            elif rid not in (task.get("requirements") or []):
                problems.append(f"需求「{rid}」说任务「{task_id}」为它而做，但该任务没有指回「{rid}」。")
        check_evidence(rid, requirement, problems)

    for task in tasks:
        tid = task.get("id")
        owners = task.get("requirements") or []
        if not owners:
            problems.append(f"任务「{tid}」不指向任何需求：范围蔓延，或者漏登记了需求。")
        for rid in owners:
            requirement = requirement_by_id.get(rid)
            if requirement is None:
                problems.append(f"任务「{tid}」指向需求「{rid}」，需求表里没有它。")
            elif tid not in (requirement.get("tasks") or []):
                problems.append(f"任务「{tid}」说它为需求「{rid}」而做，但该需求没有列它。")
        if task.get("batch") not in batch_ids:
            problems.append(f"任务「{tid}」的批次「{task.get('batch')}」不在批次表里。")

    in_some_batch: set[str] = set()
    for batch in batches:
        bid = batch.get("id")
        if "check" in batch:
            problems.append(
                f"批次「{bid}」带了手写的出口检查。出口不手写：它就是这个批次名下的全部证据，"
                "由 spec-accept 的脚本运行。删掉 check 字段。"
            )
        listed = batch.get("evidence") or []
        if not listed:
            problems.append(f"批次「{bid}」名下没有证据：它的出口证明不了任何一条需求。")
        for eid in listed:
            if eid not in evidence_owner:
                problems.append(f"批次「{bid}」列了证据「{eid}」，需求表里没有这条证据。")
            in_some_batch.add(eid)
    for eid, rid in evidence_owner.items():
        requirement = requirement_by_id.get(rid) or {}
        if requirement.get("status", "active") == "active" and eid not in in_some_batch:
            problems.append(f"证据「{eid}」（需求 {rid}）没有归入任何批次：没有哪个出口会去跑它。")

    for leftover in leftovers:
        rid = leftover.get("requirement")
        if not rid:
            problems.append(
                f"遗留项「{leftover.get('id')}」没有写明它欠的是哪条需求。"
                "遗留项算不算阻塞，不由记下它的人决定。"
            )
        elif rid not in requirement_by_id:
            problems.append(f"遗留项「{leftover.get('id')}」挂在需求「{rid}」上，需求表里没有它。")

    # 表和文档有没有漂移：编号必须能在对应的文档里找到。
    documents = trace.get("documents") or {}
    for key, rows, label in (("requirements", requirements, "需求"), ("plan", tasks, "任务")):
        path = documents.get(key)
        if not path:
            continue
        full = os.path.join(base, path)
        if not os.path.exists(full):
            problems.append(f"documents.{key} 指向的文件不存在：{path}")
            continue
        with open(full, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        for row in rows:
            identifier = str(row.get("id", ""))
            if identifier and not re.search(rf"(?<![A-Za-z0-9_-]){re.escape(identifier)}(?![A-Za-z0-9_-])", text):
                problems.append(f"{label}「{identifier}」在 {path} 里找不到：表和文档对不上了。")
    design = documents.get("design")
    if design and not os.path.exists(os.path.join(base, design)):
        problems.append(f"documents.design 指向的文件不存在：{design}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="查需求书、设计书、计划书之间对不对得上。")
    parser.add_argument("trace", help="trace.json 的路径")
    parser.add_argument("--cwd", default=None, help="文档路径相对的目录，默认是 trace.json 所在目录")
    arguments = parser.parse_args()

    trace = load(arguments.trace)
    base = os.path.abspath(arguments.cwd or os.path.dirname(os.path.abspath(arguments.trace)))
    problems = check_structure(trace, base)
    if problems:
        print(f"三份文档有 {len(problems)} 处对不上：")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1

    requirements = trace.get("requirements") or []
    active = [row for row in requirements if row.get("status", "active") == "active"]
    print(
        f"对得上：{len(active)} 条生效需求、{len(requirements) - len(active)} 条已推迟，"
        f"{len(trace.get('tasks') or [])} 个任务，{len(trace.get('batches') or [])} 个批次，"
        f"{sum(len(row.get('evidence') or []) for row in active)} 条证据。"
    )
    owed = trace.get("leftovers") or []
    if owed:
        print(f"注意：有 {len(owed)} 条遗留项。它们挂着的需求在验收时会记为未满足。")
    print("\n各批次的出口检查（原样用作议程里该阶段的出口命令）：")
    for batch in trace.get("batches") or []:
        print(f"  {batch.get('id')}: {RUNNER} {arguments.trace} --batch {batch.get('id')} --cwd <项目根目录>")
    print("\n脚本查不了的一件事：需求书里的每句要求是否都拆成了带编号的条目。请需求所有者过目。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
