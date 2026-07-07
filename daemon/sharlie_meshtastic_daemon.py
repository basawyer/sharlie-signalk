#!/usr/bin/env python3
"""Listen on Meshtastic for boat-info requests and reply with SignalK data."""

from __future__ import annotations

import argparse
import logging
import math
import os
import signal
import sys
import threading
import time
from typing import Any, Optional

import requests
from pubsub import pub

import meshtastic.tcp_interface

DEFAULT_MESHTASTIC_HOST = "192.168.8.105"
DEFAULT_MESHTASTIC_PORT = 4403
DEFAULT_CHANNEL_INDEX = 1
DEFAULT_SIGNALK_URL = "http://localhost:3000"
DEFAULT_TRIGGER = "boat info"
MAX_MESSAGE_BYTES = 200
RECONNECT_DELAY_SECONDS = 10

LOG = logging.getLogger("sharlie-meshtastic-daemon")


def load_config() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reply to Meshtastic boat-info requests with SignalK data."
    )
    parser.add_argument(
        "--meshtastic-host",
        default=os.environ.get("MESHTASTIC_HOST", DEFAULT_MESHTASTIC_HOST),
        help="Meshtastic device IP/hostname (env: MESHTASTIC_HOST)",
    )
    parser.add_argument(
        "--meshtastic-port",
        type=int,
        default=int(os.environ.get("MESHTASTIC_PORT", DEFAULT_MESHTASTIC_PORT)),
        help="Meshtastic TCP port (env: MESHTASTIC_PORT)",
    )
    parser.add_argument(
        "--channel-index",
        type=int,
        default=int(os.environ.get("MESHTASTIC_CHANNEL", DEFAULT_CHANNEL_INDEX)),
        help="Meshtastic channel index (env: MESHTASTIC_CHANNEL)",
    )
    parser.add_argument(
        "--signalk-url",
        default=os.environ.get("SIGNALK_URL", DEFAULT_SIGNALK_URL),
        help="SignalK server base URL (env: SIGNALK_URL)",
    )
    parser.add_argument(
        "--trigger",
        default=os.environ.get("TRIGGER_PHRASE", DEFAULT_TRIGGER),
        help='Incoming text that triggers a reply (env: TRIGGER_PHRASE)',
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args()


def sk_value(node: Any) -> Optional[float]:
    if not isinstance(node, dict):
        return None

    if "value" in node:
        try:
            value = node["value"]
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    return None


def fetch_signalk_path(signalk_url: str, path: str) -> Optional[float]:
    path_url = path.replace(".", "/")
    url = signalk_url.rstrip("/") + f"/signalk/v1/api/vessels/self/{path_url}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return sk_value(response.json())
    except requests.RequestException as exc:
        LOG.debug("SignalK path %s unavailable: %s", path, exc)
        return None


def fetch_first_path(signalk_url: str, paths: list[str]) -> Optional[float]:
    for path in paths:
        value = fetch_signalk_path(signalk_url, path)
        if value is not None:
            LOG.debug("Using SignalK path %s", path)
            return value
    return None


def mps_to_knots(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return value * 1.94384


def radians_to_degrees(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return math.degrees(value) % 360


def fmt_number(value: Optional[float], precision: int = 1) -> str:
    if value is None or not math.isfinite(value):
        return "n/a"
    return f"{value:.{precision}f}"


BATTERY_ID = "0"

DEPTH_PATHS = [
    "environment.depth.belowTransducer",
]

WIND_SPEED_PATHS = [
    "environment.wind.speedApparent",
]

def format_battery_line(signalk_url: str) -> Optional[str]:
    voltage = fetch_signalk_path(
        signalk_url, f"electrical.batteries.{BATTERY_ID}.voltage"
    )
    soc = fetch_signalk_path(
        signalk_url,
        f"electrical.batteries.{BATTERY_ID}.capacity.stateOfCharge",
    )
    current = fetch_signalk_path(
        signalk_url, f"electrical.batteries.{BATTERY_ID}.current"
    )

    if voltage is None and soc is None and current is None:
        return None

    parts = [f"Battery: {fmt_number(voltage, 1)}V"]
    if soc is not None:
        parts.append(f"{fmt_number(soc * 100, 0)}%")
    if current is not None:
        parts.append(f"{fmt_number(current, 1)}A")
    return " ".join(parts)


def format_boat_info(signalk_url: str) -> list[str]:
    lines = ["Sharlie status"]

    battery_line = format_battery_line(signalk_url)
    if battery_line:
        lines.append(battery_line)

    depth = fetch_first_path(signalk_url, DEPTH_PATHS)
    if depth is not None:
        lines.append(f"Depth: {fmt_number(depth, 1)}m")

    wind_speed = mps_to_knots(fetch_first_path(signalk_url, WIND_SPEED_PATHS))
    if wind_speed is not None:
        lines.append(
            f"Wind: {fmt_number(wind_speed, 0)}kn"
        )

    if len(lines) == 1:
        lines.append("No live N2K data in SignalK")

    return split_messages(lines)


def split_messages(lines: list[str]) -> list[str]:
    messages: list[str] = []
    current = ""

    for line in lines:
        candidate = line if not current else f"{current}\n{line}"
        if len(candidate.encode("utf-8")) <= MAX_MESSAGE_BYTES:
            current = candidate
            continue

        if current:
            messages.append(current)
            current = ""

        encoded = line.encode("utf-8")
        if len(encoded) <= MAX_MESSAGE_BYTES:
            current = line
            continue

        truncated = encoded[: MAX_MESSAGE_BYTES - 3].decode("utf-8", errors="ignore")
        messages.append(truncated + "...")

    if current:
        messages.append(current)

    return messages


class SharlieMeshtasticDaemon:
    def __init__(self, config: argparse.Namespace) -> None:
        self.config = config
        self.interface: Optional[meshtastic.tcp_interface.TCPInterface] = None
        self._running = True
        # Set when the Meshtastic link drops or we're asked to stop.
        self._wake = threading.Event()

    def connect(self) -> None:
        LOG.info(
            "Connecting to Meshtastic at %s:%s",
            self.config.meshtastic_host,
            self.config.meshtastic_port,
        )
        self.interface = meshtastic.tcp_interface.TCPInterface(
            hostname=self.config.meshtastic_host,
            portNumber=self.config.meshtastic_port,
        )
        pub.subscribe(self.on_receive, "meshtastic.receive.text")
        pub.subscribe(self.on_connection_lost, "meshtastic.connection.lost")
        LOG.info(
            "Listening on channel %s for trigger %r",
            self.config.channel_index,
            self.config.trigger,
        )

    def close(self) -> None:
        for callback, topic in (
            (self.on_receive, "meshtastic.receive.text"),
            (self.on_connection_lost, "meshtastic.connection.lost"),
        ):
            try:
                pub.unsubscribe(callback, topic)
            except Exception:
                pass
        if self.interface is not None:
            try:
                self.interface.close()
            except Exception:
                pass
            self.interface = None

    def on_connection_lost(self, interface: Any = None, topic: Any = None) -> None:
        LOG.warning("Meshtastic connection lost")
        self._wake.set()

    def on_receive(self, packet: dict[str, Any], interface: Any) -> None:
        if not self._running:
            return

        channel = packet.get("channel", 0)
        if channel != self.config.channel_index:
            return

        decoded = packet.get("decoded", {})
        message = decoded.get("text", "")
        if not isinstance(message, str):
            return

        if message.strip().casefold() != self.config.trigger.casefold():
            LOG.debug("Ignoring message on ch %s: %r", channel, message)
            return

        sender = packet.get("fromId", "unknown")
        LOG.info("Trigger received from %s on channel %s", sender, channel)

        try:
            replies = self.build_replies()
        except Exception as exc:
            LOG.exception("Failed to fetch/format SignalK data")
            replies = [f"SignalK error: {exc}"]

        for reply in replies:
            LOG.info("Sending reply (%s bytes): %r", len(reply.encode("utf-8")), reply)
            interface.sendText(reply, channelIndex=self.config.channel_index)
            time.sleep(0.5)

    def build_replies(self) -> list[str]:
        return format_boat_info(self.config.signalk_url)

    def run(self) -> None:
        while self._running:
            self._wake.clear()

            try:
                self.connect()
            except Exception as exc:
                LOG.warning(
                    "Could not connect to Meshtastic (%s); retrying in %ss",
                    exc,
                    RECONNECT_DELAY_SECONDS,
                )
                self.close()
                self._wake.wait(RECONNECT_DELAY_SECONDS)
                continue

            # Block until the connection drops or we're told to stop.
            self._wake.wait()
            self.close()

            if self._running:
                LOG.info("Reconnecting in %ss", RECONNECT_DELAY_SECONDS)
                self._wake.clear()
                self._wake.wait(RECONNECT_DELAY_SECONDS)

    def stop(self) -> None:
        self._running = False
        self._wake.set()
        self.close()


def main() -> int:
    config = load_config()
    logging.basicConfig(
        level=getattr(logging, config.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    daemon = SharlieMeshtasticDaemon(config)

    def handle_signal(signum: int, _frame: Any) -> None:
        LOG.info("Received signal %s, shutting down", signum)
        daemon.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        daemon.run()
    except KeyboardInterrupt:
        daemon.stop()
    except Exception:
        LOG.exception("Daemon failed")
        daemon.stop()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
