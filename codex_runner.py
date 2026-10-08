from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path

CODEX_HOME = Path.home() / ".codex"
CONFIG_FILE = CODEX_HOME / "config.toml"
MODELS_CACHE_FILE = CODEX_HOME / "models_cache.json"
SESSION_DIRECTORIES = (CODEX_HOME / "sessions", CODEX_HOME / "archived_sessions")
ROLLOUT_GLOB = "rollout-*.jsonl"
RUN_TIMEOUT_SECONDS = 900
COMMAND_TIMEOUT_SECONDS = 30


def executable_path() -> str | None:
    return shutil.which("codex")


def _run_command(arguments: list[str], timeout: int = COMMAND_TIMEOUT_SECONDS, stdin_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [executable_path() or "codex", *arguments],
        input=stdin_text,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# 手动补充的候选模型：codex CLI 的 models_cache.json 由官方接口刷新，
# 可能不含中转/新发布的 slug；此处追加后会与缓存按 slug 去重合并。
EXTRA_MODELS = [
    {
        "slug": "gpt-6.1-sol",
        "display_name": "GPT-6.1-Sol",
        "description": "GPT-6.1 Sol（手动添加的候选模型）",
    },
]


def cached_models() -> list[dict]:
    """读取 Codex CLI 缓存的可用模型清单（~/.codex/models_cache.json），并合并手动补充模型。"""
    try:
        data = json.loads(MODELS_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    models = data.get("models") if isinstance(data, dict) else None
    if not isinstance(models, list):
        models = []
    result = []
    seen = set()
    for item in [*models, *EXTRA_MODELS]:
        if not isinstance(item, dict) or not item.get("slug"):
            continue
        slug = str(item["slug"])
        if slug in seen:
            continue
        seen.add(slug)
        result.append(
            {
                "slug": slug,
                "display_name": str(item.get("display_name") or item["slug"]),
                "description": str(item.get("description") or ""),
            }
        )
    return result


def default_model() -> str | None:
    """从 ~/.codex/config.toml 读取默认模型（只做解析，不修改配置）。"""
    try:
        config = tomllib.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    value = config.get("model")
    return str(value) if value else None


def codex_status() -> dict:
    status: dict = {
        "installed": False,
        "path": None,
        "version": None,
        "logged_in": False,
        "login_status": None,
        "default_model": None,
        "models": [],
    }
    path = executable_path()
    if not path:
        return status
    status["installed"] = True
    status["path"] = path
    try:
        status["version"] = _run_command(["--version"]).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        status["version"] = None
    try:
        result = _run_command(["login", "status"])
        text = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        status["login_status"] = text or None
        lowered = text.lower()
        status["logged_in"] = bool(text) and "not logged in" not in lowered and "未登录" not in text and "no active session" not in lowered
    except (OSError, subprocess.SubprocessError) as error:
        status["login_status"] = f"无法查询登录状态：{error}"
    status["default_model"] = default_model()
    status["models"] = cached_models()
    return status


def snapshot_session_files() -> set[str]:
    """记录当前 Codex 会话文件快照，供运行后对比清理。"""
    seen: set[str] = set()
    for directory in SESSION_DIRECTORIES:
        if not directory.is_dir():
            continue
        for path in directory.rglob(ROLLOUT_GLOB):
            seen.add(str(path))
    return seen


def delete_new_sessions(snapshot: set[str]) -> list[str]:
    """删除快照之后新增的会话文件（检测产生的临时对话），并清理空目录。"""
    deleted: list[str] = []
    for path_text in sorted(snapshot_session_files() - snapshot):
        path = Path(path_text)
        try:
            path.unlink()
            deleted.append(path.name)
        except OSError:
            continue
    for directory in SESSION_DIRECTORIES:
        if not directory.is_dir():
            continue
        for child in sorted(directory.rglob("*"), reverse=True):
            if child.is_dir():
                try:
                    child.rmdir()
                except OSError:
                    continue
    return deleted


def run_codex_challenge(prompt: str, model: str, timeout: int = RUN_TIMEOUT_SECONDS) -> str:
    """驱动本机 Codex CLI 在一个独立临时会话中回答挑战，返回模型最终回复文本。

    - `codex exec` 每次调用即一个全新独立会话（互不共享上下文）；
    - `--ephemeral` 让本次会话不落盘；`--sandbox read-only` 禁止模型写文件；
    - `-o` 把最终回复写入临时文件，读取后整个临时目录随上下文销毁。
    """
    path = executable_path()
    if not path:
        raise RuntimeError("未找到 codex 命令，请先安装 Codex CLI 并完成 codex login。")
    with tempfile.TemporaryDirectory(prefix="modeltrace-codex-") as workspace:
        message_file = Path(workspace) / "last-message.txt"
        arguments = [
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox", "read-only",
            "--color", "never",
            "-C", workspace,
            "-m", model,
            "-o", str(message_file),
            "-",
        ]
        try:
            process = _run_command(arguments, timeout=timeout, stdin_text=prompt)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"codex 会话超时（>{timeout} 秒），本次挑战已中止。") from error
        except OSError as error:
            raise RuntimeError(f"无法启动 codex：{error}") from error
        text = ""
        if message_file.exists():
            text = message_file.read_text(encoding="utf-8", errors="replace").strip()
        if process.returncode != 0 or not text:
            details = (process.stderr or process.stdout or "").strip().splitlines()
            reason = details[-1] if details else f"exit code {process.returncode}"
            raise RuntimeError(f"codex 会话失败：{reason}")
        return text
