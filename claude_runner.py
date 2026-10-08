from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from challenge_suite import FIXED_SYSTEM_PREFIX

CLAUDE_HOME = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_HOME / "projects"
SESSIONS_DIR = CLAUDE_HOME / "sessions"
SETTINGS_FILE = CLAUDE_HOME / "settings.json"
STATE_FILE = Path.home() / ".claude.json"
CREDENTIALS_FILE = CLAUDE_HOME / ".credentials.json"
SESSION_DIRECTORIES = (PROJECTS_DIR, SESSIONS_DIR)
RUN_TIMEOUT_SECONDS = 900
COMMAND_TIMEOUT_SECONDS = 30

MODEL_ALIASES = (
    {"slug": "sonnet", "display_name": "最新 Sonnet"},
    {"slug": "opus", "display_name": "最新 Opus"},
    {"slug": "haiku", "display_name": "最新 Haiku"},
    {"slug": "default", "display_name": "CLI 默认模型"},
)

# 挑战提示词本身要求不调用任何工具，这里再把 CLI 内置工具全部禁用，形成双保险。
DISABLED_TOOLS = "Bash Edit Write Read Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit KillShell BashOutput"


def executable_path() -> str | None:
    return shutil.which("claude")


def _run_command(arguments: list[str], timeout: int = COMMAND_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [executable_path() or "claude", *arguments],
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
    )


def _settings() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def default_model() -> str | None:
    value = _settings().get("model")
    return str(value) if value else None


def auth_state() -> tuple[bool, str]:
    """判断 Claude Code 是否具备可用凭据（订阅登录或 API Key），只读不写、不回显密钥。"""
    env_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    env_base = os.environ.get("ANTHROPIC_BASE_URL")
    if env_key:
        suffix = f" · 中转 {env_base}" if env_base else ""
        return True, f"环境变量 API Key{suffix}"
    settings_env = _settings().get("env")
    if isinstance(settings_env, dict) and (settings_env.get("ANTHROPIC_AUTH_TOKEN") or settings_env.get("ANTHROPIC_API_KEY")):
        base_url = settings_env.get("ANTHROPIC_BASE_URL")
        suffix = f" · 中转 {base_url}" if base_url else ""
        return True, f"settings.json API Key{suffix}"
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    account = data.get("oauthAccount") if isinstance(data, dict) else None
    if isinstance(account, dict):
        return True, f"已登录订阅：{account.get('emailAddress') or '已连接账号'}"
    if CREDENTIALS_FILE.exists():
        return True, "已保存登录凭据"
    return False, "未检测到 API Key 或登录凭据"


def claude_status() -> dict:
    status: dict = {
        "installed": False,
        "path": None,
        "version": None,
        "logged_in": False,
        "auth_status": None,
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
    logged_in, auth_text = auth_state()
    status["logged_in"] = logged_in
    status["auth_status"] = auth_text
    status["default_model"] = default_model()
    status["models"] = [dict(item) for item in MODEL_ALIASES]
    return status


def snapshot_session_files() -> set[str]:
    """记录当前 Claude 会话文件快照，供运行后对比清理。"""
    seen: set[str] = set()
    for directory in SESSION_DIRECTORIES:
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if path.is_file():
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


def run_claude_challenge(prompt: str, model: str, timeout: int = RUN_TIMEOUT_SECONDS) -> str:
    """驱动本机 Claude Code CLI 在一个独立临时会话中回答挑战，返回模型最终回复文本。

    - 每次 `claude -p` 调用即一个全新独立会话（互不共享上下文）；
    - `--system-prompt` 把 Claude Code 默认系统提示词整体替换为指纹库的固定前缀，
      让测试条件尽量贴近干净 API 的采集环境；
    - `--disallowedTools` 禁用全部内置工具，与挑战词中的禁用要求形成双保险；
    - 工作目录是一次性临时目录，会话转录落在独立的 projects 子目录，运行后统一删除。
    """
    path = executable_path()
    if not path:
        raise RuntimeError("未找到 claude 命令，请先安装 Claude Code CLI 并完成登录。")
    with tempfile.TemporaryDirectory(prefix="modeltrace-claude-") as workspace:
        arguments = [
            "-p",
            prompt,
            "--output-format", "json",
            "--model", model,
            "--system-prompt", FIXED_SYSTEM_PREFIX,
            # 注意：--disallowedTools 是可变参数，会吞掉其后的位置参数，prompt 必须放在最前。
            "--disallowedTools", DISABLED_TOOLS,
        ]
        try:
            process = subprocess.run(
                [path, *arguments],
                cwd=workspace,
                capture_output=True,
                text=True,
                timeout=timeout,
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"claude 会话超时（>{timeout} 秒），本次挑战已中止。") from error
        except OSError as error:
            raise RuntimeError(f"无法启动 claude：{error}") from error
        text = ""
        try:
            data = json.loads(process.stdout)
        except ValueError:
            data = None
        if isinstance(data, dict):
            text = str(data.get("result") or "").strip()
        if not text:
            text = process.stdout.strip()
        if process.returncode != 0 or not text:
            details = (process.stderr or process.stdout or "").strip().splitlines()
            reason = details[-1] if details else f"exit code {process.returncode}"
            raise RuntimeError(f"claude 会话失败：{reason}")
        return text