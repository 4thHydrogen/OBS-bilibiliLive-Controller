#!/usr/bin/env python3
"""Bilibili 直播标题监控 - 标题变更时通过 Bark 推送通知"""

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "live_monitor_config.json"
STATE_FILE = SCRIPT_DIR / "live_monitor_state.json"

BILI_API = "https://api.live.bilibili.com/room/v1/Room/get_info"


def load_config():
    if not CONFIG_FILE.exists():
        print(f"配置文件不存在: {CONFIG_FILE}")
        print("请复制 live_monitor_config.example.json 为 live_monitor_config.json 并填写配置")
        sys.exit(1)
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def fetch_room_title(room_id, cookie=None):
    url = f"{BILI_API}?room_id={room_id}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    if cookie:
        req.add_header("Cookie", cookie)

    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    if data.get("code") != 0:
        raise RuntimeError(f"B站API返回错误: code={data.get('code')}, msg={data.get('message')}")

    room_info = data["data"]
    return {
        "title": room_info["title"],
        "live_status": room_info["live_status"],  # 0=未开播, 1=直播中, 2=轮播
        "room_id": room_info["room_id"],
    }


def send_bark(server_url, key, title, body, group="直播监控"):
    server_url = server_url.rstrip("/")
    title_encoded = urllib.request.quote(title)
    body_encoded = urllib.request.quote(body)
    group_encoded = urllib.request.quote(group)
    url = f"{server_url}/{key}/{title_encoded}/{body_encoded}?group={group_encoded}"

    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        return result.get("code") == 200


def run_once(config):
    room_id = config["room_id"]
    cookie = config.get("cookie", "")

    try:
        room = fetch_room_title(room_id, cookie)
    except Exception as e:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 获取房间信息失败: {e}")
        return

    state = load_state()
    prev_title = state.get("title")
    current_title = room["title"]
    status_map = {0: "未开播", 1: "直播中", 2: "轮播中"}
    status_text = status_map.get(room["live_status"], f"未知({room['live_status']})")

    if prev_title is None:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 首次运行，记录当前标题: {current_title} ({status_text})")
        save_state({"title": current_title, "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
        return

    if current_title != prev_title:
        bark_cfg = config["bark"]
        push_title = "直播标题变更"
        push_body = f"{prev_title} → {current_title}\n状态: {status_text}"

        try:
            success = send_bark(
                bark_cfg["server_url"],
                bark_cfg["key"],
                push_title,
                push_body,
                bark_cfg.get("group", "直播监控"),
            )
            if success:
                print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 标题变更已推送: {prev_title} → {current_title}")
            else:
                print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Bark推送返回非成功状态")
        except Exception as e:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Bark推送失败: {e}")

        save_state({"title": current_title, "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    else:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 标题未变化: {current_title} ({status_text})")


def main():
    config = load_config()

    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        interval = config.get("check_interval", 300)
        print(f"守护模式启动，每 {interval} 秒检查一次 (Ctrl+C 退出)")
        while True:
            run_once(config)
            time.sleep(interval)
    else:
        run_once(config)


if __name__ == "__main__":
    main()
