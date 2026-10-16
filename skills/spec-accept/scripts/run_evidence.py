#!/usr/bin/env python3
"""run_evidence.py — 把追溯表里的证据真的跑一遍。

只管验收阶段：读 trace.json，运行证据命令，如实报告。不检查文档写得对不对
（那是 spec-trace 的事），不改任何文件，除了写出验收结论。

用法：
  run_evidence.py <trace.json> --batch <批次号> [--cwd <项目根目录>]   判定一个批次能否出口
  run_evidence.py <trace.json> --requirement <需求号> [--cwd <根>]     只判定一条需求
  run_evidence.py <trace.json> [--cwd <项目根目录>]                    全量验收，写 acceptance.json

只用标准库。退出码：0 = 全部通过 / 全部满足；1 = 有没通过的；2 = 用法或文件错误。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any


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


def run_one(command: str, cwd: str, timeout: int) -> dict[str, Any]:
    started = time.time()
    if command.strip() == "":
        return {"exitCode": None, "tail": "这条证据没有命令", "seconds": 0.0}
    try:
        done = subprocess.run(
            command, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout, errors="replace"
        )
        output = (done.stdout or "") + (("\n" + done.stderr) if done.stderr else "")
        return {"exitCode": done.returncode, "tail": output.strip()[-1500:], "seconds": round(time.time() - started, 1)}
    except subprocess.TimeoutExpired:
        return {"exitCode": None, "tail": f"超过 {timeout} 秒没有结束", "seconds": float(timeout), "timedOut": True}


def evidence_index(trace: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any]]]:
    """证据编号 → (它属于哪条需求, 证据本身)。"""
    index: dict[str, tuple[str, dict[str, Any]]] = {}
    for requirement in trace.get("requirements") or []:
        for evidence in requirement.get("evidence") or []:
            if evidence.get("id"):
                index[evidence["id"]] = (requirement.get("id"), evidence)
    return index


def run_guards(trace: dict[str, Any], batch_id: str | None, cwd: str, timeout: int) -> list[dict[str, Any]]:
    """守卫：不属于任何一条需求、但出口都要过的检查（没有弄坏别的）。

    写在追溯表里而不是另一个出口脚本里。`batches` 不写就对每个批次都生效。
    """
    results: list[dict[str, Any]] = []
    for guard in trace.get("guards") or []:
        only = guard.get("batches")
        if batch_id is not None and only and batch_id not in only:
            continue
        outcome = run_one(str(guard.get("run", "")), cwd, timeout)
        passed = outcome["exitCode"] == 0
        print(f"  {'✓' if passed else '✗'} 守卫 {guard.get('id')}（{outcome['seconds']} 秒）：{guard.get('run')}", flush=True)
        if not passed and outcome["tail"].strip():
            print("      " + outcome["tail"].strip()[-600:].replace("\n", "\n      "))
        results.append({"id": guard.get("id"), "run": guard.get("run"), **outcome})
    return results


def run_batch(trace: dict[str, Any], batch_id: str, cwd: str, timeout: int) -> int:
    batch = next((row for row in trace.get("batches") or [] if row.get("id") == batch_id), None)
    if batch is None:
        known = ", ".join(str(row.get("id")) for row in trace.get("batches") or [])
        print(f"追溯表里没有批次「{batch_id}」。有的是：{known or '（一个都没有）'}", file=sys.stderr)
        return 2
    listed = batch.get("evidence") or []
    if not listed:
        # 一个什么都不证明的出口不能算通过。
        print(f"批次「{batch_id}」名下没有证据，它的出口证明不了任何东西：不通过。")
        return 1
    index = evidence_index(trace)
    failed: list[str] = []
    print(f"批次「{batch_id}」出口：运行 {len(listed)} 条证据")
    for eid in listed:
        if eid not in index:
            print(f"  ✗ {eid}：追溯表里没有这条证据")
            failed.append(eid)
            continue
        rid, evidence = index[eid]
        outcome = run_one(str(evidence.get("run", "")), cwd, timeout)
        passed = outcome["exitCode"] == 0
        print(f"  {'✓' if passed else '✗'} {eid}（需求 {rid}，{outcome['seconds']} 秒）：{evidence.get('run')}", flush=True)
        if not passed:
            failed.append(eid)
            tail = outcome["tail"].strip()
            if tail:
                print("      " + tail[-600:].replace("\n", "\n      "))
    broken = [str(one["id"]) for one in run_guards(trace, batch_id, cwd, timeout) if one["exitCode"] != 0]
    if failed or broken:
        parts = []
        if failed:
            parts.append(f"{len(failed)} 条证据没通过（{', '.join(failed)}）")
        if broken:
            parts.append(f"{len(broken)} 条守卫没通过（{', '.join(broken)}）")
        print(f"\n批次「{batch_id}」不能出口：{'；'.join(parts)}。")
        return 1
    print(f"\n批次「{batch_id}」可以出口：{len(listed)} 条证据全部通过。")
    return 0


def run_requirement(trace: dict[str, Any], requirement_id: str, cwd: str, timeout: int) -> int:
    """只判定一条需求：它的证据全部通过，且没有遗留项挂在它上面。

    给「补做这一条需求」的议程节点当出口用：补做的是哪一条，量的就是哪一条。
    """
    requirement = next((row for row in trace.get("requirements") or [] if row.get("id") == requirement_id), None)
    if requirement is None:
        print(f"追溯表里没有需求「{requirement_id}」。", file=sys.stderr)
        return 2
    if requirement.get("status") == "deferred":
        print(f"需求「{requirement_id}」已推迟，不算满足。")
        return 1
    listed = requirement.get("evidence") or []
    failed: list[str] = []
    print(f"需求「{requirement_id}」{requirement.get('title') or ''}：运行 {len(listed)} 条证据")
    for evidence in listed:
        outcome = run_one(str(evidence.get("run", "")), cwd, timeout)
        passed = outcome["exitCode"] == 0
        print(f"  {'✓' if passed else '✗'} {evidence.get('id')}（{outcome['seconds']} 秒）：{evidence.get('run')}", flush=True)
        if not passed:
            failed.append(str(evidence.get("id")))
            if outcome["tail"].strip():
                print("      " + outcome["tail"].strip()[-600:].replace("\n", "\n      "))
    owed = [one for one in trace.get("leftovers") or [] if one.get("requirement") == requirement_id]
    for one in owed:
        print(f"  ✗ 遗留项 {one.get('id')}：{one.get('what', '')}")
    if not listed:
        print("  ✗ 没有证据")
    if failed or owed or not listed:
        print(f"\n需求「{requirement_id}」未满足。")
        return 1
    print(f"\n需求「{requirement_id}」满足。")
    return 0


def run_all(trace: dict[str, Any], cwd: str, timeout: int, out: str) -> int:
    owed: dict[Any, list[dict[str, Any]]] = {}
    for leftover in trace.get("leftovers") or []:
        owed.setdefault(leftover.get("requirement"), []).append(leftover)

    verdicts: list[dict[str, Any]] = []
    print("全量验收：")
    for requirement in trace.get("requirements") or []:
        rid = requirement.get("id")
        if requirement.get("status") == "deferred":
            verdicts.append({"id": rid, "title": requirement.get("title"), "verdict": "deferred", "reasons": [], "evidence": []})
            continue
        results: list[dict[str, Any]] = []
        for evidence in requirement.get("evidence") or []:
            outcome = run_one(str(evidence.get("run", "")), cwd, timeout)
            results.append({"id": evidence.get("id"), "run": evidence.get("run"), **outcome})
            mark = "✓" if outcome["exitCode"] == 0 else "✗"
            print(f"  {mark} {rid} · {evidence.get('id')}（{outcome['seconds']} 秒）：{evidence.get('run')}", flush=True)
        reasons = [f"证据 {one['id']} 未通过" for one in results if one["exitCode"] != 0]
        if not results:
            reasons.append("没有证据")
        reasons += [f"遗留项 {one.get('id')}：{one.get('what', '')}" for one in owed.get(rid, [])]
        verdicts.append(
            {
                "id": rid,
                "title": requirement.get("title"),
                "verdict": "unmet" if reasons else "met",
                "reasons": reasons,
                "evidence": results,
            }
        )

    guards = run_guards(trace, None, cwd, timeout)
    broken = [one for one in guards if one["exitCode"] != 0]
    met = [one for one in verdicts if one["verdict"] == "met"]
    unmet = [one for one in verdicts if one["verdict"] == "unmet"]
    deferred = [one for one in verdicts if one["verdict"] == "deferred"]
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "met": len(met),
                "unmet": len(unmet),
                "deferred": len(deferred),
                "guardsFailed": len(broken),
                "requirements": verdicts,
                "guards": guards,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n验收结论：满足 {len(met)}，未满足 {len(unmet)}，已推迟 {len(deferred)}。详情写入 {out}")
    for one in unmet:
        print(f"  ✗ {one['id']} {one.get('title') or ''}：{'；'.join(one['reasons'])}")
    for one in deferred:
        print(f"  — {one['id']} {one.get('title') or ''}：已推迟，不算满足")
    for one in broken:
        print(f"  ✗ 守卫 {one['id']} 没通过：{one.get('run')}")
    return 1 if unmet or broken else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="把追溯表里的证据真的跑一遍。")
    parser.add_argument("trace", help="trace.json 的路径")
    parser.add_argument("--batch", default=None, help="只判定这一个批次能否出口")
    parser.add_argument("--requirement", default=None, help="只判定这一条需求是否满足")
    parser.add_argument("--cwd", default=None, help="证据命令在哪个目录下运行，默认是 trace.json 所在目录")
    parser.add_argument("--timeout", type=int, default=1800, help="单条证据最长运行秒数，默认 1800")
    parser.add_argument("--out", default=None, help="全量验收的结论写到哪，默认是 trace.json 旁边的 acceptance.json")
    arguments = parser.parse_args()

    trace = load(arguments.trace)
    cwd = os.path.abspath(arguments.cwd or os.path.dirname(os.path.abspath(arguments.trace)))
    if arguments.batch is not None:
        return run_batch(trace, arguments.batch, cwd, arguments.timeout)
    if arguments.requirement is not None:
        return run_requirement(trace, arguments.requirement, cwd, arguments.timeout)
    out = arguments.out or os.path.join(os.path.dirname(os.path.abspath(arguments.trace)), "acceptance.json")
    return run_all(trace, cwd, arguments.timeout, out)


if __name__ == "__main__":
    sys.exit(main())
