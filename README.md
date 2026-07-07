# sharlie-signalk

Boat automation for SV Sharlie: a SignalK plugin and a Meshtastic daemon.

https://www.instagram.com/svsharlie

## Projects

| Directory | Purpose |
|-----------|---------|
| [`signalk-plugin/`](signalk-plugin/) | SignalK plugin — bilge/fresh water GPIO monitoring and alarm forwarding |
| [`daemon/`](daemon/) | Meshtastic daemon — reply to `boat info` with live N2K data from SignalK |

## Meshtastic daemon (quick start)

```bash
cd daemon
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export MESHTASTIC_HOST=192.168.8.105
export SIGNALK_URL=http://localhost:3000
python sharlie_meshtastic_daemon.py
```

Send `boat info` on channel 1 to get bat0, depth, wind, water temp, and SOG/COG back.

See [`daemon/README.md`](daemon/README.md) for systemd install instructions.

## SignalK plugin

See [`signalk-plugin/README.md`](signalk-plugin/README.md).

The bilge/fresh water monitoring uses a [NOYITO PC817 4-Channel Optocoupler board](https://www.amazon.com/dp/B07GMHLL2M).
