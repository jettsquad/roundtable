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

# 规则每收紧一次加一。打印出来，是为了让在旧会话里加载过 skill 的人知道该重读。
RULES_VERSION = 3

# 不可能失败的命令。写成证据，等于没有证据。
TRIVIAL = re.compile(r"^\s*(true|:|exit\s+0|echo\b[^|&;]*|printf\b[^|&;]*)\s*$")

# 证据量到哪一层。数字越大越接近人实际用到的东西。
LEVELS = {"logic": 1, "interface": 2, "ui": 3}
LEVEL_WORDS = {"logic": "逻辑层", "interface": "接口层", "ui": "界面层"}

# 需求书里一个编号或一句话「不是需求」只能是这三种情况。「别处已经覆盖」不在
# 其中：那是一句没人核对的话，条款就是这样从表里消失的。
NOT_REQUIREMENT_KINDS = ("decision", "out-of-scope", "separate-spec")

# 引文太短等于没引：「的」「可以」在哪一行都找得到。
MIN_QUOTE_CHARS = 4

RUNNER = "python3 ~/.agents/skills/spec-accept/scripts/run_evidence.py"

HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[a-zA-Z]?[.、)）])\s+(.*\S)\s*$")
TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{2,}")


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


def squash(text: str) -> str:
    """比对用的形式：去掉空白和 Markdown 的强调、代码记号。"""
    return re.sub(r"[\s*`_]+", "", text)


def document_text(base: str, where: Any) -> tuple[str | None, list[str]]:
    """一份文档的全文。可以是一个文件、几个文件，或者一个目录（取其中的 .md）。

    返回（全文，找不到的路径）。全文为 None 表示一个文件都没读到。
    """
    paths = where if isinstance(where, list) else [where]
    texts: list[str] = []
    missing: list[str] = []
    for path in paths:
        full = os.path.join(base, str(path))
        if os.path.isdir(full):
            found = False
            for root, _dirs, files in os.walk(full):
                for name in sorted(files):
                    if name.endswith(".md"):
                        found = True
                        with open(os.path.join(root, name), encoding="utf-8", errors="replace") as handle:
                            texts.append(handle.read())
            if not found:
                missing.append(f"{path}（目录里没有 .md 文件）")
        elif os.path.exists(full):
            with open(full, encoding="utf-8", errors="replace") as handle:
                texts.append(handle.read())
        else:
            missing.append(str(path))
    return ("\n".join(texts) if texts else None), missing


def mentions(text: str, identifier: str) -> bool:
    """编号是否作为一个完整的词出现在文档里。"""
    return re.search(rf"(?<![A-Za-z0-9_-]){re.escape(identifier)}(?![A-Za-z0-9_-])", text) is not None


def clause_lines(text: str, id_pattern: str, headings: list[str]) -> tuple[list[tuple[str, str]], set[str]]:
    """需求书里要逐条交代的条款：带需求编号的小节（以及声明的小节）下面的列表项和表格行。

    返回（[(所在小节标题, 条款原文)]，这些小节标题里出现过的需求编号）。
    """
    matcher = re.compile(rf"(?<![A-Za-z0-9_-])(?:{id_pattern})(?![A-Za-z0-9_-])")
    lines: list[tuple[str, str]] = []
    sectioned: set[str] = set()
    # 当前所在的、要求逐条交代的小节：(标题级别, 标题)。遇到同级或更高级的标题就结束。
    active: tuple[int, str] | None = None
    seen_table_header = False
    for raw in text.split("\n"):
        heading = HEADING.match(raw)
        if heading is not None:
            level, title = len(heading.group(1)), heading.group(2)
            found = matcher.findall(title)
            declared = any(name and name in title for name in headings)
            if found or declared:
                active = (level, title)
                sectioned.update(found)
            elif active is not None and level <= active[0]:
                active = None
            seen_table_header = False
            continue
        if active is None:
            continue
        item = LIST_ITEM.match(raw)
        if item is not None:
            lines.append((active[1], item.group(1)))
            continue
        row = TABLE_ROW.match(raw)
        if row is None:
            seen_table_header = False
            continue
        if TABLE_RULE.match(raw):
            continue
        if not seen_table_header:
            # 表格的第一行是表头，不是条款。
            seen_table_header = True
            continue
        lines.append((active[1], row.group(1).strip()))
    return lines, sectioned


def duplicates(ids: list[Any]) -> list[Any]:
    seen: set[Any] = set()
    twice: list[Any] = []
    for one in ids:
        if one in seen and one not in twice:
            twice.append(one)
        seen.add(one)
    return twice


def check_row(rid: str, requirement: dict[str, Any], problems: list[str]) -> None:
    """一条需求的条款、端、层级和证据。"""
    clauses = requirement.get("clauses") or []
    if not clauses:
        problems.append(
            f"需求「{rid}」没有写它对应需求书里的哪些条款（clauses）。每一行要原文引用它负责的句子，"
            "否则查不出需求书里有哪句没人管。"
        )
    clause_ids: list[str] = []
    for clause in clauses:
        cid = str(clause.get("id", "")).strip()
        quote = str(clause.get("quote", "")).strip()
        if cid == "":
            problems.append(f"需求「{rid}」有一条条款没有 id。")
            continue
        clause_ids.append(cid)
        if len(squash(quote)) < MIN_QUOTE_CHARS:
            problems.append(f"条款「{cid}」（需求 {rid}）的引文太短或没有。引文要是需求书里的原话。")
    for repeated in duplicates(clause_ids):
        problems.append(f"条款编号「{repeated}」在需求「{rid}」里出现了不止一次。")

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
    covered: set[str] = set()
    for evidence in requirement.get("evidence") or []:
        eid = evidence.get("id")
        command = str(evidence.get("run", "")).strip()
        if command == "":
            problems.append(f"证据「{eid}」（需求 {rid}）没有命令。「已确认」「见截图」不是证据。")
        elif TRIVIAL.match(command):
            problems.append(f"证据「{eid}」（需求 {rid}）的命令不可能失败：{command}")
        if "failsWhen" in evidence:
            problems.append(
                f"证据「{eid}」（需求 {rid}）的 failsWhen 写在了证据上。改成按条款写："
                "covers 里每一项是 {\"clause\": 条款编号, \"failsWhen\": 这条条款不成立时它怎么失败}。"
            )
        covers = evidence.get("covers") or []
        if not covers:
            problems.append(f"证据「{eid}」（需求 {rid}）没有写它量的是哪些条款（covers）。")
        for cover in covers:
            cid = str(cover.get("clause", "")).strip()
            if cid not in clause_ids:
                problems.append(f"证据「{eid}」（需求 {rid}）说它量条款「{cid}」，这一行没有这条条款。")
                continue
            if not str(cover.get("failsWhen", "")).strip():
                problems.append(
                    f"证据「{eid}」没写条款「{cid}」不成立时它会怎么失败（failsWhen）。"
                    "写不出来，就是它没量到这一条。"
                )
                continue
            covered.add(cid)
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

    for cid in clause_ids:
        if cid not in covered:
            problems.append(f"条款「{cid}」（需求 {rid}）没有任何证据量它：这句话做没做到无法证明。")
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


def check_documents(trace: dict[str, Any], base: str, problems: list[str]) -> None:
    """表和文档有没有漂移；需求书里的每个编号、每句条款有没有交代。"""
    requirements = trace.get("requirements") or []
    tasks = trace.get("tasks") or []
    requirement_ids = {str(row.get("id")) for row in requirements}
    documents = trace.get("documents") or {}

    for key in ("requirements", "design", "plan"):
        if key in documents:
            _text, missing = document_text(base, documents[key])
            for path in missing:
                problems.append(f"documents.{key} 指向的文件不存在：{path}")

    excused_ids: set[str] = set()
    excused_quotes: list[str] = []
    for entry in trace.get("notRequirements") or []:
        label = entry.get("id") or str(entry.get("quote", ""))[:30]
        kind = str(entry.get("kind", "")).strip()
        if kind not in NOT_REQUIREMENT_KINDS:
            problems.append(
                f"notRequirements 里的「{label}」的 kind 是「{kind}」。只能是 decision（决策或背景）、"
                "out-of-scope（不在本期范围）、separate-spec（另起规格）。「别处已经覆盖」不是理由："
                "它负责的每句话要么被某一行引用，要么各自说明。"
            )
        if not str(entry.get("reason", "")).strip():
            problems.append(f"notRequirements 里的「{label}」没有写原因。")
        if entry.get("id"):
            excused_ids.add(str(entry["id"]))
        if entry.get("quote"):
            excused_quotes.append(squash(str(entry["quote"])))

    if "requirements" not in documents:
        problems.append("没有写 documents.requirements：不知道需求书在哪，什么都对不了。")
    else:
        text, _missing = document_text(base, documents["requirements"])
        if text is not None:
            flat = squash(text)
            for row in requirements:
                identifier = str(row.get("id", ""))
                # 验收行的编号常常只是「7」，在需求书里到处都是；它靠 acceptance 和引文对上。
                if identifier and "acceptance" not in row and not mentions(text, identifier):
                    problems.append(f"需求「{identifier}」在需求书里找不到：表和文档对不上了。")
            quotes: list[str] = []
            for row in requirements:
                for clause in row.get("clauses") or []:
                    quote = squash(str(clause.get("quote", "")))
                    if len(quote) < MIN_QUOTE_CHARS:
                        continue
                    quotes.append(quote)
                    if quote not in flat:
                        problems.append(
                            f"条款「{clause.get('id')}」（需求 {row.get('id')}）的引文在需求书里找不到："
                            f"「{str(clause.get('quote'))[:40]}」。引文要是原话，不是转述。"
                        )
            for quote in excused_quotes:
                if quote and quote not in flat:
                    problems.append("notRequirements 里有一条引文在需求书里找不到。引文要是原话。")

            pattern = documents.get("requirementIdPattern")
            if not pattern:
                problems.append(
                    "没有写 documents.requirementIdPattern（需求编号的写法，正则，例如 \"FR-\\\\d+|D\\\\d+\"）。"
                    "没有它，查不出需求书里有哪些编号、哪些条款没进这张表。"
                )
            else:
                try:
                    found = sorted(set(re.findall(rf"(?<![A-Za-z0-9_-])(?:{pattern})(?![A-Za-z0-9_-])", text)))
                    declared = [str(name) for name in documents.get("clauseHeadings") or []]
                    lines, sectioned = clause_lines(text, pattern, declared)
                except re.error as error:
                    found, lines, sectioned = [], [], set()
                    problems.append(f"documents.requirementIdPattern 不是合法的正则：{error}")
                # 每句条款都要有人管：被某一行引用，或者说明它为什么不是需求。
                for title, line in lines:
                    flat_line = squash(line)
                    if any(quote in flat_line or flat_line in quote for quote in quotes + excused_quotes):
                        continue
                    problems.append(
                        f"需求书「{title}」下的这一条没有被任何一行引用：「{line[:70]}」。"
                        "它是需求就加进某一行的 clauses 并给它证据；不是就记进 notRequirements（带 quote 和 kind）。"
                    )
                # 每个编号都要有交代。一个有自己小节的编号，由上面的逐句检查管；
                # 其余的必须是表里的一行，或者说明它为什么不是需求。
                for identifier in found:
                    if identifier in requirement_ids or identifier in excused_ids or identifier in sectioned:
                        continue
                    problems.append(
                        f"需求书里的「{identifier}」不在这张表里。它是需求就加一行；"
                        "不是就记进 notRequirements，写明 kind 和原因。"
                    )

    if "plan" in documents:
        text, _missing = document_text(base, documents["plan"])
        if text is not None:
            for row in tasks:
                identifier = str(row.get("id", ""))
                if identifier and not mentions(text, identifier):
                    problems.append(f"任务「{identifier}」在计划书里找不到：表和文档对不上了。")
    elif tasks:
        problems.append(
            "没有写 documents.plan。计划书是几个文件就写成列表，是一个目录就写目录——"
            "不写的话，查不了任务编号是否真的在计划书里。"
        )


def check_structure(trace: dict[str, Any], base: str) -> list[str]:
    """返回漏洞列表。空列表 = 三份文档对得上。"""
    problems: list[str] = []
    requirements = trace.get("requirements") or []
    tasks = trace.get("tasks") or []
    batches = trace.get("batches") or []
    leftovers = trace.get("leftovers") or []
    guards = trace.get("guards") or []

    if not requirements:
        problems.append("requirements 是空的：没有需求，就没有东西可以追溯。")

    for kind, rows in (
        ("需求", requirements),
        ("任务", tasks),
        ("批次", batches),
        ("遗留项", leftovers),
        ("守卫", guards),
    ):
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
        check_row(rid, requirement, problems)

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
                f"批次「{bid}」带了手写的出口检查。出口不手写：它就是这个批次名下的全部证据"
                "（加上 guards），由 spec-accept 的脚本运行。删掉 check 字段。"
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

    # 守卫：不属于任何一条需求、但出口都要过的检查（没有弄坏别的）。写在这张表里，
    # 而不是另一个出口脚本里——两处判据就会各走各的。
    for guard in guards:
        gid = guard.get("id")
        command = str(guard.get("run", "")).strip()
        if command == "":
            problems.append(f"守卫「{gid}」没有命令。")
        elif TRIVIAL.match(command):
            problems.append(f"守卫「{gid}」的命令不可能失败：{command}")
        if not str(guard.get("why", "")).strip():
            problems.append(f"守卫「{gid}」没有写它防的是什么（why）。")
        for bid in guard.get("batches") or []:
            if bid not in batch_ids:
                problems.append(f"守卫「{gid}」列了批次「{bid}」，批次表里没有它。")

    for leftover in leftovers:
        rid = leftover.get("requirement")
        if not rid:
            problems.append(
                f"遗留项「{leftover.get('id')}」没有写明它欠的是哪条需求。"
                "遗留项算不算阻塞，不由记下它的人决定。"
            )
        elif rid not in requirement_by_id:
            problems.append(f"遗留项「{leftover.get('id')}」挂在需求「{rid}」上，需求表里没有它。")

    # 同一条命令不能充当两条证据。给它们起不同的编号不改变事实：一条命令
    # 量的是一件事，而这张表声称它量了好几件。
    by_command: dict[str, list[str]] = {}
    for requirement in requirements:
        if requirement.get("status", "active") != "active":
            continue
        for evidence in requirement.get("evidence") or []:
            command = " ".join(str(evidence.get("run", "")).split())
            if command:
                by_command.setdefault(command, []).append(f"{evidence.get('id')}（需求 {requirement.get('id')}）")
    for command, users in by_command.items():
        if len(users) > 1:
            problems.append(
                f"{len(users)} 条证据用的是同一条命令：{'、'.join(users)}。一条命令只量一件事——"
                f"为每条需求写出只量它的那一条（指到具体的用例）；现有测试量不到的，写一条现在会失败的。命令：{command}"
            )

    # 验收条目：需求所有者按它们逐条验收，所以每一条必须是表里独立的一行。
    if "acceptanceItems" not in trace:
        problems.append(
            "没有写 acceptanceItems（需求书里验收条目的清单）。需求书没有验收清单就写成空列表 []——"
            "不写的话，分不清是没有验收条目，还是忘了列。"
        )
    items = [str(item) for item in trace.get("acceptanceItems") or []]
    claimed: dict[str, list[str]] = {}
    for requirement in requirements:
        label = requirement.get("acceptance")
        if label is None:
            continue
        if isinstance(label, list):
            problems.append(
                f"需求「{requirement.get('id')}」的 acceptance 是一个列表。一行只对应一条验收条目："
                "几条并在一行里，其中一条不满足时分不清是哪条。拆成几行。"
            )
            continue
        claimed.setdefault(str(label), []).append(str(requirement.get("id")))
        if items and str(label) not in items:
            problems.append(f"需求「{requirement.get('id')}」对应验收条目「{label}」，acceptanceItems 里没有这一条。")
    for item in items:
        rows = claimed.get(item, [])
        if not rows:
            problems.append(f"验收条目「{item}」在表里没有对应的行：它不会被任何证据量到。")
        elif len(rows) > 1:
            problems.append(f"验收条目「{item}」被 {len(rows)} 行同时认领（{'、'.join(rows)}）。一条验收条目对应一行。")

    check_documents(trace, base, problems)
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
        print(
            f"spec-trace 规则第 {RULES_VERSION} 版。如果你是在之前的会话里加载的这个 skill，规则可能已经变了："
            "先重新加载 spec-trace、读完 SKILL.md，再改这张表。不要只看报错来凑。"
        )
        print(f"\n三份文档有 {len(problems)} 处对不上：")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1

    requirements = trace.get("requirements") or []
    active = [row for row in requirements if row.get("status", "active") == "active"]
    print(
        f"对得上（规则第 {RULES_VERSION} 版）：{len(active)} 条生效需求、{len(requirements) - len(active)} 条已推迟，"
        f"{sum(len(row.get('clauses') or []) for row in active)} 句条款，"
        f"{len(trace.get('tasks') or [])} 个任务，{len(trace.get('batches') or [])} 个批次，"
        f"{sum(len(row.get('evidence') or []) for row in active)} 条证据，{len(trace.get('guards') or [])} 条守卫。"
    )
    owed = trace.get("leftovers") or []
    if owed:
        print(f"注意：有 {len(owed)} 条遗留项。它们挂着的需求在验收时会记为未满足。")
    print("\n各批次的出口检查（原样用作议程里该阶段的出口命令；项目里不再另设出口脚本）：")
    for batch in trace.get("batches") or []:
        print(f"  {batch.get('id')}: {RUNNER} {arguments.trace} --batch {batch.get('id')} --cwd <项目根目录>")
    print(
        "\n脚本查不了的两件事，请需求所有者过目：\n"
        "  1. 需求书里写在段落正文中（不在列表、表格里）的要求，有没有被引用。\n"
        "  2. 每条 failsWhen 说的是不是那条测试实际断言的东西。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
