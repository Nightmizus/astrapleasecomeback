"""Codex gpt-6-astra 定时检测：东八区每天 7/12/17 点各跑一次指纹归因，历史落盘供页面展示。"""

from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import codex_runner
from fingerprint import analyze_global_outputs, generate_challenges, load_bank, parse_numbers

TZ = ZoneInfo("Asia/Shanghai")
MONITOR_MODEL = "gpt-6-astra"
MONITOR_HOURS = (7, 12, 17)
HISTORY_FILE = Path(__file__).resolve().parent / "data" / "monitor_history.json"
MAX_RECORDS = 5000
CHALLENGE_TIMEOUT_SECONDS = 600

_bank: dict | None = None
_lock = threading.Lock()
_started = False
_running = False


def set_bank(bank: dict | None) -> None:
    global _bank
    _bank = bank


def _active_bank() -> dict:
    return _bank or load_bank(HISTORY_FILE.with_name("unified_bank.json"))


def load_history() -> list[dict]:
    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    records = data.get("records") if isinstance(data, dict) else None
    return [item for item in records if isinstance(item, dict)] if isinstance(records, list) else []


def _save_history(records: list[dict]) -> None:
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(
        json.dumps({"records": records[-MAX_RECORDS:]}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _append_record(record: dict) -> None:
    with _lock:
        records = load_history()
        records.append(record)
        _save_history(records)


def run_monitor_check(trigger: str = "manual") -> dict:
    """跑一次完整检测：1 个挑战会话 → 指纹归因 → 判定是否 gpt-6-astra → 记入历史。"""
    global _running
    if _running:
        raise RuntimeError("已有一个检测正在运行，请稍候。")
    _running = True
    started_wall = datetime.now(TZ)
    started_monotonic = time.monotonic()
    record: dict = {
        "id": f"mon-{int(started_wall.timestamp())}-{trigger}",
        "trigger": trigger,
        "model_requested": MONITOR_MODEL,
        "started_at": started_wall.isoformat(timespec="seconds"),
        "status": "error",
        "attributed": None,
        "probability": None,
        "parsed_numbers": 0,
        "minimum_numbers": 0,
        "duration_seconds": None,
        "error": None,
    }
    challenge = generate_challenges(1)[0]
    record["minimum_numbers"] = max(80, math.ceil(challenge["expected_count"] * 0.55))
    snapshot = codex_runner.snapshot_session_files()
    try:
        text = codex_runner.run_codex_challenge(
            challenge["prompt"], MONITOR_MODEL, timeout=CHALLENGE_TIMEOUT_SECONDS
        )
    except RuntimeError as error:
        record["error"] = str(error)
    else:
        parsed = parse_numbers(text)
        record["parsed_numbers"] = len(parsed)
        if len(parsed) < record["minimum_numbers"]:
            record["status"] = "invalid"
            record["error"] = f"有效数字 {len(parsed)} 个，低于阈值 {record['minimum_numbers']}。"
        else:
            try:
                result = analyze_global_outputs(
                    [{"text": text, "expected_count": challenge["expected_count"]}],
                    _active_bank(),
                )
                top = result["results"][0]
                record["attributed"] = top["model"]
                record["probability"] = round(float(top["probability"]), 4)
                record["status"] = "ok" if top["model"] == MONITOR_MODEL else "wrong_model"
                if record["status"] == "wrong_model":
                    record["error"] = f"归因结果为 {top['model']}，不是 {MONITOR_MODEL}。"
            except Exception as error:  # noqa: BLE001 —— 归因失败也要落一条可展示的记录
                record["status"] = "error"
                record["error"] = f"归因失败：{error}"
    finally:
        record["duration_seconds"] = round(time.monotonic() - started_monotonic, 1)
        codex_runner.delete_new_sessions(snapshot)
        _append_record(record)
        _running = False
    return record


def is_running() -> bool:
    return _running


def next_run_time(now: datetime | None = None) -> datetime:
    local = (now or datetime.now(TZ)).astimezone(TZ)
    for hour in MONITOR_HOURS:
        candidate = local.replace(hour=hour, minute=0, second=0, microsecond=0)
        if candidate > local:
            return candidate
    return local.replace(hour=MONITOR_HOURS[0], minute=0, second=0, microsecond=0) + timedelta(days=1)


def _last_due_slot(local_now: datetime) -> datetime | None:
    candidates = [
        local_now.replace(hour=hour, minute=0, second=0, microsecond=0) - timedelta(days=days)
        for days in (0, 1)
        for hour in MONITOR_HOURS
    ]
    passed = [item for item in candidates if item <= local_now]
    return max(passed) if passed else None


def _missed_startup_check(local_now: datetime) -> bool:
    due = _last_due_slot(local_now)
    if due is None:
        return False
    records = load_history()
    if not records:
        return True
    try:
        last_started = datetime.fromisoformat(records[-1]["started_at"]).astimezone(TZ)
    except (KeyError, ValueError):
        return True
    return last_started < due


def _scheduler_loop() -> None:
    time.sleep(20)
    if _missed_startup_check(datetime.now(TZ)):
        try:
            run_monitor_check("startup")
        except Exception as error:  # noqa: BLE001 —— 调度线程绝不能崩
            print(f"[monitor] 启动补跑失败：{error}", flush=True)
    while True:
        wait_seconds = (next_run_time() - datetime.now(TZ)).total_seconds()
        time.sleep(max(1.0, wait_seconds) + 30.0)
        try:
            run_monitor_check("scheduled")
        except Exception as error:  # noqa: BLE001
            print(f"[monitor] 定时检测失败：{error}", flush=True)


def start_monitor(bank: dict | None = None) -> None:
    global _started
    if _started:
        return
    if bank is not None:
        set_bank(bank)
    threading.Thread(target=_scheduler_loop, daemon=True, name="modeltrace-monitor").start()
    _started = True


def history_payload() -> dict:
    with _lock:
        records = load_history()
    ok_count = sum(1 for item in records if item.get("status") == "ok")
    return {
        "model": MONITOR_MODEL,
        "hours": list(MONITOR_HOURS),
        "timezone": "Asia/Shanghai",
        "running": is_running(),
        "next_run_at": next_run_time().isoformat(timespec="minutes"),
        "records": records,
        "total": len(records),
        "ok_count": ok_count,
    }
