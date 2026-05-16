# -*- coding: utf-8 -*-
"""
XJ-GPT 协议注册机 Web GUI。

独立入口,保留原 CLI(main.py)不变。

用法:
    python web_app.py                 # 默认 127.0.0.1:5000
    python web_app.py --port 8000
    python web_app.py --host 0.0.0.0  # 暴露到局域网(自担风险)
"""
import argparse
import email
import html
import json
import logging
import queue
import random
import re
import string
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
from email import policy
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, render_template, request

from config import proxy as proxy_config
from config import geo as geo_config
from core.account_export import create_batch_archive_dir
from core.email_provider import acquire_email
from core.otp_utils import extract_otp
from core.outlook_client import OutlookAccount
from main import generate_display_name, run_registration


logger = logging.getLogger(__name__)

# ============================================================
# 全局状态:同时只允许一个批次,所以模块级共享即可
# ============================================================

_BATCH_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_LOG_QUEUE: "queue.Queue[str]" = queue.Queue(maxsize=10000)

_BATCH_STATE: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "mode": None,
    "target": 0,
    "submitted": 0,
    "done": 0,
    "success": 0,
    "failed": 0,
    "last_error": None,
    "otp_waiting": False,
    "otp_email": None,
    "results": [],
}

_OTP_CONDITION = threading.Condition()
_OTP_REQUEST: dict = {
    "waiting": False,
    "email": None,
    "code": None,
    "requested_at": None,
}


def _reset_state(mode: str, target: int) -> None:
    with _STATE_LOCK:
        _BATCH_STATE.update({
            "running": True,
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "mode": mode,
            "target": target,
            "submitted": 0,
            "done": 0,
            "success": 0,
            "failed": 0,
            "last_error": None,
            "otp_waiting": False,
            "otp_email": None,
            "results": [],
        })


def _snapshot_state() -> dict:
    with _STATE_LOCK:
        return {
            **_BATCH_STATE,
            "results": list(_BATCH_STATE["results"][-50:]),
        }


def _record_result(result: dict) -> None:
    with _STATE_LOCK:
        _BATCH_STATE["done"] += 1
        if result.get("success"):
            _BATCH_STATE["success"] += 1
        else:
            _BATCH_STATE["failed"] += 1
            _BATCH_STATE["last_error"] = result.get("error") or "未知错误"
        _BATCH_STATE["results"].append({
            "email": result.get("email"),
            "success": bool(result.get("success")),
            "error": result.get("error"),
            "account_id": result.get("account_id"),
            "flow": result.get("flow", {}).get("status") if isinstance(result.get("flow"), dict) else None,
        })


def _parse_manual_email(line: str) -> str:
    email = line.strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise ValueError(f"邮箱格式错误: {email[:80]}")
    return email


def _wait_for_gui_otp(email: str, after_ts: float) -> str:
    del after_ts
    with _OTP_CONDITION:
        _OTP_REQUEST.update({
            "waiting": True,
            "email": email,
            "code": None,
            "requested_at": datetime.now().isoformat(timespec="seconds"),
        })
        with _STATE_LOCK:
            _BATCH_STATE["otp_waiting"] = True
            _BATCH_STATE["otp_email"] = email
        logger.info(f"[OTP] 请在页面输入 {email} 收到的 6 位验证码")

        while _OTP_REQUEST["waiting"] and not _OTP_REQUEST["code"]:
            _OTP_CONDITION.wait(timeout=1.0)

        code = str(_OTP_REQUEST.get("code") or "").strip()
        _OTP_REQUEST.update({"waiting": False, "email": None, "code": None})
        with _STATE_LOCK:
            _BATCH_STATE["otp_waiting"] = False
            _BATCH_STATE["otp_email"] = None
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("验证码必须是 6 位数字")
        return code


# ============================================================
# 日志:自定义 Handler 推到 SSE 队列
# ============================================================

class QueueLogHandler(logging.Handler):
    """把每条 LogRecord 格式化后扔进 _LOG_QUEUE。满了直接丢弃,不阻塞业务。"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            _LOG_QUEUE.put_nowait(msg)
        except queue.Full:
            pass
        except Exception:
            self.handleError(record)


def _setup_logging(verbose: bool = False) -> None:
    """配置 root logger:控制台 + SSE 队列。沿用 main.py 的格式。"""
    fmt = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)

    if not any(isinstance(h, logging.StreamHandler) and not isinstance(h, QueueLogHandler)
               for h in root.handlers):
        stream = logging.StreamHandler()
        stream.setFormatter(fmt)
        root.addHandler(stream)

    if not any(isinstance(h, QueueLogHandler) for h in root.handlers):
        qh = QueueLogHandler()
        qh.setFormatter(fmt)
        qh.setLevel(logging.INFO)
        root.addHandler(qh)

    if verbose:
        logging.getLogger("core").setLevel(logging.DEBUG)
    else:
        logging.getLogger("core").setLevel(logging.INFO)
        logging.getLogger("urllib3").setLevel(logging.WARNING)
        logging.getLogger("requests").setLevel(logging.WARNING)
        logging.getLogger("werkzeug").setLevel(logging.WARNING)


# ============================================================
# 批次调度
# ============================================================

def _parse_manual_line(line: str) -> OutlookAccount:
    """
    解析一行邮箱,自动识别两种格式:

    1. 标准格式(4 段 ---- 分隔):
       email----password----client_id----refresh_token

    2. 冒号变体(7 段 : 分隔,[2]/[5] 为空,[3]/[6] 是同一个 refresh_token):
       email:password::refresh_token:client_id::refresh_token
    """
    s = line.strip()
    if not s:
        raise ValueError("空行")

    if "----" in s:
        parts = s.split("----")
        if len(parts) != 4 or not all(p.strip() for p in parts):
            raise ValueError(f"标准格式错误,期望 4 段 ---- 分隔: {s[:80]}")
        email, pwd, cid, rt = (p.strip() for p in parts)
        return OutlookAccount(email=email, password=pwd, client_id=cid, refresh_token=rt)

    if ":" in s:
        parts = [p.strip() for p in s.split(":")]
        if len(parts) >= 5 and parts[0] and parts[1] and parts[3] and parts[4]:
            email, pwd, rt, cid = parts[0], parts[1], parts[3], parts[4]
            return OutlookAccount(email=email, password=pwd, client_id=cid, refresh_token=rt)

    raise ValueError(f"无法识别的邮箱格式: {s[:80]}")


def _gui_run_batch(
    mode: str,
    manual_lines: list[str],
    count: int,
    workers: int,
    continue_on_fail: bool,
) -> None:
    """实际执行批次的后台函数。在专门的线程里跑。"""
    try:
        batch_dir = create_batch_archive_dir(count, workers)
        logger.info(f"[GUI] 本批次归档目录: {batch_dir}")

        email_queue: "queue.Queue[str]" = queue.Queue()
        if mode == "manual":
            for line in manual_lines:
                email_queue.put(_parse_manual_email(line))

        def next_email() -> str:
            if mode == "manual":
                return email_queue.get_nowait()
            return acquire_email()

        def task(idx: int) -> dict:
            try:
                email = next_email()
            except queue.Empty:
                return {"success": False, "error": "manual 邮箱队列已空,无法继续"}
            try:
                name = generate_display_name()
                return run_registration(
                    email=email,
                    name=name,
                    birthday="2000-01-01",
                    otp_callback=_wait_for_gui_otp if mode == "manual" else None,
                    batch_dir=batch_dir,
                )
            except Exception as exc:
                logger.error(f"[GUI] 第 {idx + 1} 个任务异常: {type(exc).__name__}: {exc}")
                return {"success": False, "email": email, "error": str(exc)}

        future_to_idx: dict = {}
        next_idx = 0
        stop_submit = False

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="reg-gui") as ex:
            while len(future_to_idx) < workers and next_idx < count and not stop_submit:
                future_to_idx[ex.submit(task, next_idx)] = next_idx
                next_idx += 1
                with _STATE_LOCK:
                    _BATCH_STATE["submitted"] = next_idx

            while future_to_idx:
                done, _ = wait(future_to_idx, return_when=FIRST_COMPLETED)
                for fut in done:
                    idx = future_to_idx.pop(fut)
                    try:
                        result = fut.result()
                    except Exception as exc:
                        result = {"success": False, "error": f"{type(exc).__name__}: {exc}"}
                        logger.error(f"[GUI] 第 {idx + 1} 个 future 异常: {exc}")
                    _record_result(result)

                    if not result.get("success") and not continue_on_fail:
                        stop_submit = True
                        logger.warning("[GUI] 当前账号失败,已停止提交新任务(已提交的会跑完)")

                while len(future_to_idx) < workers and next_idx < count and not stop_submit:
                    future_to_idx[ex.submit(task, next_idx)] = next_idx
                    next_idx += 1
                    with _STATE_LOCK:
                        _BATCH_STATE["submitted"] = next_idx

        with _STATE_LOCK:
            s = _BATCH_STATE["success"]
            f = _BATCH_STATE["failed"]
        logger.info(f"[GUI] 批次结束: 成功 {s} / 失败 {f} / 目标 {count}")
    except Exception as exc:
        logger.exception(f"[GUI] 批次线程崩溃: {exc}")
        with _STATE_LOCK:
            _BATCH_STATE["last_error"] = f"批次崩溃: {type(exc).__name__}: {exc}"
    finally:
        with _STATE_LOCK:
            _BATCH_STATE["running"] = False
            _BATCH_STATE["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _BATCH_LOCK.release()


# ============================================================
# Flask app
# ============================================================

app = Flask(__name__)


def _random_mailbox_name() -> str:
    letters1 = "".join(random.choices(string.ascii_lowercase, k=5))
    numbers = "".join(random.choices(string.digits, k=random.randint(1, 3)))
    letters2 = "".join(random.choices(string.ascii_lowercase, k=random.randint(1, 3)))
    return letters1 + numbers + letters2


def _mail_response_items(data) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("mails", "data", "items", "results", "messages"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def _find_raw_mime(item) -> str:
    if isinstance(item, str):
        return item
    if not isinstance(item, dict):
        return ""
    for key in ("raw", "source", "content", "mime", "eml"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value
    for value in item.values():
        if isinstance(value, dict):
            found = _find_raw_mime(value)
            if found:
                return found
    return ""


def _decode_part(part) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        text = part.get_payload()
        return text if isinstance(text, str) else ""
    charset = part.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def _parse_raw_mail(raw: str) -> dict:
    msg = email.message_from_string(raw, policy=policy.default)
    text_parts: list[str] = []
    html_parts: list[str] = []

    if msg.is_multipart():
        parts = msg.walk()
    else:
        parts = [msg]

    for part in parts:
        content_type = part.get_content_type()
        if part.get_content_maintype() == "multipart":
            continue
        if content_type == "text/plain":
            text_parts.append(_decode_part(part))
        elif content_type == "text/html":
            html_parts.append(_decode_part(part))

    html_text = "\n".join(html_parts)
    return {
        "subject": str(msg.get("subject") or ""),
        "from": str(msg.get("from") or ""),
        "text": "\n".join(text_parts),
        "html": html.unescape(re.sub(r"<[^>]+>", " ", html_text)),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify(_snapshot_state())


@app.route("/api/otp", methods=["POST"])
def api_otp_submit():
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        return jsonify({"ok": False, "error": "验证码必须是 6 位数字"}), 400

    with _OTP_CONDITION:
        if not _OTP_REQUEST.get("waiting"):
            return jsonify({"ok": False, "error": "当前没有等待验证码的任务"}), 409
        _OTP_REQUEST["code"] = code
        email = _OTP_REQUEST.get("email")
        _OTP_CONDITION.notify_all()

    logger.info(f"[OTP] 已从页面收到验证码：{email}")
    return jsonify({"ok": True})


@app.route("/api/custom-mail/new-address", methods=["POST"])
def api_custom_mail_new_address():
    logger.info("[CustomMail] 收到创建邮箱请求")
    try:
        from config import custom_mail
    except Exception as exc:
        return jsonify({"ok": False, "error": f"读取邮箱 API 配置失败: {exc}"}), 500

    base = (custom_mail.MAIL_API_BASE or "").rstrip("/")
    admin_auth = custom_mail.ADMIN_AUTH or ""
    domain = custom_mail.MAIL_DOMAIN or ""
    custom_auth = custom_mail.CUSTOM_AUTH or ""

    if not base or not admin_auth or not domain:
        return jsonify({
            "ok": False,
            "error": "请先配置 config/custom_mail.py 里的 MAIL_API_BASE、ADMIN_AUTH、MAIL_DOMAIN",
        }), 400

    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip() or _random_mailbox_name()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
        return jsonify({"ok": False, "error": "邮箱名称只能包含字母、数字、点、下划线和短横线"}), 400

    payload_data = {
        "enablePrefix": bool(custom_mail.ENABLE_PREFIX),
        "name": name,
        "domain": domain,
    }
    headers = {
        "x-admin-auth": admin_auth,
        "Content-Type": "application/json",
    }
    if custom_auth:
        headers["x-custom-auth"] = custom_auth

    url = f"{base}/admin/new_address"
    try:
        from curl_cffi.requests import Session

        proxy_url = proxy_config.pick_proxy()
        debug_headers = dict(headers)
        if debug_headers.get("x-admin-auth"):
            debug_headers["x-admin-auth"] = "***"
        if debug_headers.get("x-custom-auth"):
            debug_headers["x-custom-auth"] = "***"
        logger.info(
            "[CustomMail] 请求: POST %s proxy=%s headers=%s body=%s",
            url,
            proxy_url or "(直连)",
            debug_headers,
            json.dumps(payload_data, ensure_ascii=False),
        )
        session = Session(impersonate="chrome142")
        if proxy_url:
            session.proxies = {"http": proxy_url, "https": proxy_url}
        resp = session.post(url, json=payload_data, headers=headers, timeout=25)
        logger.info("[CustomMail] 响应: HTTP %s body=%s", resp.status_code, resp.text[:2000])
        if resp.status_code >= 400:
            return jsonify({
                "ok": False,
                "error": f"HTTP {resp.status_code}: {resp.text[:500]}",
            }), 502
        result = resp.json()
    except Exception as exc:
        logger.exception("[CustomMail] 创建邮箱失败")
        return jsonify({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }), 502

    address = result.get("address")
    if not address:
        return jsonify({"ok": False, "error": f"接口响应缺少 address: {result}"}), 502

    logger.info(f"[CustomMail] 已创建邮箱地址: {address}")
    return jsonify({
        "ok": True,
        "address": address,
        "jwt": result.get("jwt"),
        "address_id": result.get("address_id"),
    })


@app.route("/api/custom-mail/latest-otp", methods=["POST"])
def api_custom_mail_latest_otp():
    try:
        from config import custom_mail
        from curl_cffi.requests import Session
    except Exception as exc:
        return jsonify({"ok": False, "error": f"初始化邮箱 API 失败: {exc}"}), 500

    base = (custom_mail.MAIL_API_BASE or "").rstrip("/")
    custom_auth = custom_mail.CUSTOM_AUTH or ""
    data = request.get_json(silent=True) or {}
    address = str(data.get("address") or "").strip()
    jwt = str(data.get("jwt") or "").strip()
    if not base:
        return jsonify({"ok": False, "error": "请先配置 config/custom_mail.py 里的 MAIL_API_BASE"}), 400
    if not jwt:
        return jsonify({"ok": False, "error": "请填写该邮箱地址对应的地址 JWT"}), 400

    headers = {
        "Authorization": f"Bearer {jwt}",
        "Content-Type": "application/json",
    }
    if custom_auth:
        headers["x-custom-auth"] = custom_auth

    url = f"{base}/api/mails?limit=10&offset=0"
    proxy_url = proxy_config.pick_proxy()
    debug_headers = dict(headers)
    debug_headers["Authorization"] = "Bearer ***"
    if debug_headers.get("x-custom-auth"):
        debug_headers["x-custom-auth"] = "***"
    logger.info(
        "[CustomMail] 拉取邮件: GET %s address=%s proxy=%s headers=%s",
        url,
        address or "(未指定)",
        proxy_url or "(直连)",
        debug_headers,
    )

    try:
        session = Session(impersonate="chrome142")
        if proxy_url:
            session.proxies = {"http": proxy_url, "https": proxy_url}
        resp = session.get(url, headers=headers, timeout=25)
        logger.info("[CustomMail] 邮件响应: HTTP %s body=%s", resp.status_code, resp.text[:2000])
        if resp.status_code >= 400:
            return jsonify({"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:500]}"}), 502
        payload = resp.json()
    except Exception as exc:
        logger.exception("[CustomMail] 拉取邮件失败")
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 502

    items = _mail_response_items(payload)
    scanned = 0
    for item in items:
        scanned += 1
        mail_item = item if isinstance(item, dict) else {}
        raw = _find_raw_mime(item)
        if raw:
            mail_item = {**mail_item, **_parse_raw_mail(raw)}
        otp = extract_otp(mail_item)
        if otp:
            return jsonify({
                "ok": True,
                "otp": otp,
                "subject": mail_item.get("subject") or "",
                "from": mail_item.get("from") or mail_item.get("sendEmail") or "",
                "scanned": scanned,
            })

    return jsonify({
        "ok": False,
        "error": f"最近 {len(items)} 封邮件里没有找到 6 位验证码",
        "scanned": len(items),
    }), 404


_ALLOWED_PROXY_SCHEMES = {"http", "https", "socks5", "socks5h"}

# 持久化写 config/proxy.py 时用的锁,避免并发写覆盖
_PERSIST_LOCK = threading.Lock()

# config/proxy.py 路径(用于持久化)
_PROXY_CONFIG_PATH = Path(__file__).resolve().parent / "config" / "proxy.py"

# 连通性测试的探活目标(同时也是注册流程的真实域)
_PROBE_URL = "https://chatgpt.com/cdn-cgi/trace"
_PROBE_TIMEOUT = 10


def _validate_proxy_url(raw: str) -> str:
    """校验代理 URL,返回 normalized 值。空串表示直连,允许通过。"""
    s = (raw or "").strip()
    if s == "":
        return ""
    try:
        u = urlparse(s)
    except Exception as exc:
        raise ValueError(f"无法解析代理 URL: {exc}")
    if u.scheme not in _ALLOWED_PROXY_SCHEMES:
        raise ValueError(
            f"不支持的协议 '{u.scheme}',只接受 {sorted(_ALLOWED_PROXY_SCHEMES)}"
        )
    if not u.hostname:
        raise ValueError("缺少 host,期望形如 http://127.0.0.1:7890")
    if u.port is not None and not (1 <= u.port <= 65535):
        raise ValueError(f"端口超出范围: {u.port}")
    return s


def _persist_proxy_pool(new_pool: list[str]) -> None:
    """
    把新的 PROXY_POOL 列表持久化到 config/proxy.py,并同步更新内存中的列表。

    用正则替换文件里的 `PROXY_POOL = [...]` 块。原子写入(.tmp + rename)。
    并发安全:通过 _PERSIST_LOCK 串行化。
    """
    if new_pool:
        entries = "\n".join(f'    "{p}",' for p in new_pool)
        new_block = "PROXY_POOL = [\n" + entries + "\n]"
    else:
        new_block = "PROXY_POOL = []"

    with _PERSIST_LOCK:
        text = _PROXY_CONFIG_PATH.read_text(encoding="utf-8")
        pattern = r"PROXY_POOL\s*=\s*\[[\s\S]*?\]"
        new_text, n = re.subn(pattern, new_block, text, count=1)
        if n != 1:
            raise RuntimeError(
                "无法在 config/proxy.py 中找到 PROXY_POOL = [...] 块"
            )
        tmp = _PROXY_CONFIG_PATH.with_suffix(".py.tmp")
        tmp.write_text(new_text, encoding="utf-8")
        tmp.replace(_PROXY_CONFIG_PATH)

        # 同步更新内存中的列表(用 slice 赋值保证所有持有引用的代码都能看到新值)
        proxy_config.PROXY_POOL[:] = new_pool


def _probe_proxy(proxy_url: str, timeout: int = _PROBE_TIMEOUT) -> dict:
    """
    用 curl_cffi(impersonate 同主流程)访问 chatgpt.com 的 trace 端点,
    返回连通性 + 出口 IP + Cloudflare 机房代码。proxy_url=='' 表示直连。
    """
    from curl_cffi.requests import Session

    s = Session(impersonate="chrome142")
    if proxy_url:
        s.proxies = {"http": proxy_url, "https": proxy_url}
    s.timeout = timeout

    t0 = time.time()
    try:
        resp = s.get(_PROBE_URL)
        elapsed = (time.time() - t0) * 1000
        info: dict[str, str] = {}
        for line in (resp.text or "").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                info[k.strip()] = v.strip()
        return {
            "ok": resp.status_code == 200,
            "http_status": resp.status_code,
            "elapsed_ms": round(elapsed),
            "ip": info.get("ip"),
            "loc": info.get("loc"),
            "colo": info.get("colo"),
        }
    except Exception as exc:
        elapsed = (time.time() - t0) * 1000
        return {
            "ok": False,
            "http_status": None,
            "elapsed_ms": round(elapsed),
            "error": f"{type(exc).__name__}: {str(exc)[:200]}",
        }


@app.route("/api/proxy", methods=["GET"])
def api_proxy_get():
    return jsonify({
        "override": proxy_config.get_runtime_proxy(),
        "pool": list(proxy_config.PROXY_POOL),
        "effective": proxy_config.pick_proxy(),
    })


@app.route("/api/proxy", methods=["POST"])
def api_proxy_set():
    data = request.get_json(silent=True) or {}
    if "proxy" not in data:
        return jsonify({"ok": False, "error": "请求体缺少 'proxy' 字段"}), 400

    val = data["proxy"]
    if val is None:
        # 仅清除运行时覆盖,不动 PROXY_POOL 也不动文件
        proxy_config.set_runtime_proxy(None)
        # 出口可能完全变了,清掉 geo 缓存让下一个 BrowserSession 重新探测
        geo_config.reset_cache()
        logger.info("[代理] 已清除 runtime override,恢复 PROXY_POOL 抽取;geo 缓存已重置")
        return jsonify({
            "ok": True,
            "override": proxy_config.get_runtime_proxy(),
            "effective": proxy_config.pick_proxy(),
            "persisted": False,
        })

    try:
        normalized = _validate_proxy_url(str(val))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    # 先持久化:失败则完全不改运行时状态,保持原子性
    new_pool = [normalized] if normalized else []
    try:
        _persist_proxy_pool(new_pool)
    except Exception as exc:
        logger.exception("[代理] 持久化失败")
        return jsonify({"ok": False, "error": f"写入 config/proxy.py 失败: {exc}"}), 500

    # 持久化成功后再设置 runtime override 让当前会话立即生效
    proxy_config.set_runtime_proxy(normalized)
    # 切换出口必然伴随 geo 变化(同一个 localhost:7890 也可能背后换了机场节点),
    # 强制重置 geo 探测缓存,下次注册会重新调 ipinfo 拿当前出口
    geo_config.reset_cache()
    logger.info(f"[代理] 已设置并持久化: {normalized or '(直连)'};geo 缓存已重置")

    return jsonify({
        "ok": True,
        "override": proxy_config.get_runtime_proxy(),
        "effective": proxy_config.pick_proxy(),
        "persisted": True,
    })


@app.route("/api/proxy/test", methods=["POST"])
def api_proxy_test():
    """
    测试代理连通性。body 里给 proxy 字段就测那个值,不给就测当前 effective。
    """
    data = request.get_json(silent=True) or {}
    if "proxy" in data and data["proxy"] is not None:
        try:
            proxy_url = _validate_proxy_url(str(data["proxy"]))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
    else:
        proxy_url = proxy_config.pick_proxy()

    result = _probe_proxy(proxy_url)
    result["proxy_used"] = proxy_url or "(直连)"
    return jsonify(result)


# OpenAI 拒绝注册的国家/地区 —— 命中时前端给红色警告
_BLOCKED_COUNTRIES: set[str] = {"CN", "HK", "RU", "IR", "KP", "SY", "CU", "VE"}


@app.route("/api/geo/detect", methods=["POST"])
def api_geo_detect():
    """
    检测当前(或指定)代理的出口地理位置,返回完整的指纹 profile。

    body:
        {"proxy": "..."}   显式探测某代理
        {"proxy": null}    不传或 null → 探测当前 effective 代理
        {"force": true}    强制清缓存重探(默认 true)

    返回:
        country / tz_name / language / languages / tz_string / tz_label / blocked
        以及 proxy_used / detected_at 用于 UI 展示
    """
    data = request.get_json(silent=True) or {}
    if "proxy" in data and data["proxy"] is not None:
        try:
            proxy_url = _validate_proxy_url(str(data["proxy"]))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
    else:
        proxy_url = proxy_config.pick_proxy()

    if bool(data.get("force", True)):
        geo_config.reset_cache()

    try:
        profile = geo_config.detect_geo(proxy_url or None)
    except Exception as exc:
        logger.exception("[Geo] 探测失败")
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500

    country = (profile.get("country") or "").upper()
    blocked = country in _BLOCKED_COUNTRIES

    logger.info(
        f"[Geo] 手动探测 proxy={proxy_url or '(直连)'} country={country} "
        f"tz={profile.get('tz_name')} lang={profile.get('language')} blocked={blocked}"
    )

    return jsonify({
        "ok": True,
        "proxy_used": proxy_url or "(直连)",
        "country": country,
        "tz_name": profile.get("tz_name"),
        "tz_string": profile.get("tz_string"),
        "tz_label": profile.get("tz_label"),
        "language": profile.get("language"),
        "languages": profile.get("languages"),
        "blocked": blocked,
        "detected_at": datetime.now().isoformat(timespec="seconds"),
    })


@app.route("/api/start", methods=["POST"])
def api_start():
    data = request.get_json(silent=True) or {}

    mode = data.get("mode", "manual")
    if mode not in ("manual", "outlook"):
        return jsonify({"ok": False, "error": "mode 必须是 manual 或 outlook"}), 400

    try:
        count = int(data.get("count", 1))
        workers = int(data.get("workers", 1))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "count / workers 必须是整数"}), 400

    if count < 1 or workers < 1:
        return jsonify({"ok": False, "error": "count / workers 必须 >= 1"}), 400

    if workers > count:
        workers = count
    if mode == "manual" and workers != 1:
        return jsonify({"ok": False, "error": "手动邮箱模式需要并发=1，避免多个验证码同时等待"}), 400

    continue_on_fail = bool(data.get("continue_on_fail", True))

    manual_lines: list[str] = []
    if mode == "manual":
        raw = data.get("emails", "")
        if isinstance(raw, list):
            manual_lines = [str(x) for x in raw if str(x).strip()]
        else:
            manual_lines = [ln for ln in str(raw).splitlines() if ln.strip()]
        if len(manual_lines) < count:
            return jsonify({
                "ok": False,
                "error": f"manual 模式需要至少 {count} 行邮箱,实际 {len(manual_lines)} 行",
            }), 400
        try:
            for ln in manual_lines[:count]:
                _parse_manual_email(ln)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    if not _BATCH_LOCK.acquire(blocking=False):
        return jsonify({"ok": False, "error": "已有批次正在运行"}), 409

    _reset_state(mode=mode, target=count)
    while not _LOG_QUEUE.empty():
        try:
            _LOG_QUEUE.get_nowait()
        except queue.Empty:
            break

    threading.Thread(
        target=_gui_run_batch,
        args=(mode, manual_lines[:count] if mode == "manual" else [], count, workers, continue_on_fail),
        daemon=True,
        name="gui-batch",
    ).start()

    return jsonify({"ok": True, "target": count, "workers": workers, "mode": mode})


@app.route("/api/logs/stream")
def api_logs_stream():
    def event_stream():
        yield "retry: 3000\n\n"
        while True:
            try:
                line = _LOG_QUEUE.get(timeout=1.0)
                payload = json.dumps({"line": line}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
            except queue.Empty:
                yield ": ping\n\n"
    return Response(event_stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


# ============================================================
# 入口
# ============================================================

def main() -> None:
    parser = argparse.ArgumentParser(description="XJ-GPT 协议注册机 Web GUI")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址,默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=5000, help="监听端口,默认 5000")
    parser.add_argument("--verbose", action="store_true", help="开启 DEBUG 日志")
    args = parser.parse_args()

    _setup_logging(args.verbose)
    logger.info(f"[GUI] Web 服务启动: http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
