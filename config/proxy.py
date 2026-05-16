# -*- coding: utf-8 -*-
"""
代理池配置

每次注册随机抽取一个代理，保证不同 sid 之间彼此独立，避免风控关联。

协议说明：
    - http:// / https://   HTTP(S) 代理
    - socks5://            SOCKS5（DNS 本地解析，可能泄漏）
    - socks5h://           SOCKS5（DNS 在代理端解析，推荐，避免 DNS-IP 错配）

运行时覆盖：
    Web GUI 可以通过 set_runtime_proxy() 设置全局覆盖,所有 pick_proxy()
    调用方(BrowserSession / outlook_client) 都会读到新值。
"""
import random


# 默认代理池(本地代理软件 7890 端口)
PROXY_POOL = [
    "http://127.0.0.1:7897",
]


# Web GUI 设置的运行时覆盖。
#   None  -> 还原 PROXY_POOL 抽取行为(默认状态)
#   ""    -> 强制不走代理(直连)
#   "..." -> 强制使用这个代理 URL
_RUNTIME_OVERRIDE: str | None = None


def set_runtime_proxy(value: str | None) -> None:
    """设置运行时代理覆盖。传 None 即清除覆盖,恢复从 PROXY_POOL 抽取。"""
    global _RUNTIME_OVERRIDE
    _RUNTIME_OVERRIDE = value


def get_runtime_proxy() -> str | None:
    """获取当前的 runtime override(可能为 None,表示未设置)。"""
    return _RUNTIME_OVERRIDE


def pick_proxy() -> str:
    """
    返回本次请求要用的代理 URL。

    优先级:
    1. 运行时覆盖 _RUNTIME_OVERRIDE(不为 None 时直接返回)
    2. PROXY_POOL 随机抽取
    3. 都没有则返回空串(直连)
    """
    if _RUNTIME_OVERRIDE is not None:
        return _RUNTIME_OVERRIDE
    return random.choice(PROXY_POOL) if PROXY_POOL else ""


# 兼容入口:历史代码可能直接 import PROXY 常量。
# 它只在 import 时计算一次,不反映 runtime override;新代码请直接调 pick_proxy()。
PROXY = pick_proxy()
