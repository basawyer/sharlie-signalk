# Sharlie Meshtastic Daemon

Listens on the Sharlie Meshtastic channel for `boat info` and replies with current boat data from SignalK (bat0 battery, depth, wind, water temp, SOG/COG).

## Quick test (manual)

On the Raspberry Pi:

```bash
cd /path/to/sharlie-signalk/daemon
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Edit values if needed
export MESHTASTIC_HOST=192.168.8.105
export MESHTASTIC_CHANNEL=1
export SIGNALK_URL=http://localhost:3000

python sharlie_meshtastic_daemon.py
```

Send `boat info` on channel 1 from another Meshtastic device. You should get one or more reply messages with live data.

### CLI flags

```bash
python sharlie_meshtastic_daemon.py \
  --meshtastic-host 192.168.8.105 \
  --channel-index 1 \
  --signalk-url http://localhost:3000 \
  --trigger "boat info"
```

## Install as a systemd service

Run directly from your git clone — no copying files around. Set up a venv in
place, then point systemd at the venv's Python and the script.

```bash
# Clone into your home directory (skip if already cloned)
git clone https://github.com/basawyer/sharlie-signalk.git ~/sharlie-signalk
cd ~/sharlie-signalk/daemon

# Create venv and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate

# Configuration
sudo cp config.example.env /etc/default/sharlie-meshtastic-daemon
sudo nano /etc/default/sharlie-meshtastic-daemon

# Install the service (edit User= / paths in the file if your username isn't basawyer)
sudo cp sharlie-meshtastic-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sharlie-meshtastic-daemon
```

The service file assumes the repo is at `~/sharlie-signalk` and your user is
`basawyer`. If either differs, edit `User=`, `WorkingDirectory=`, and
`ExecStart=` in `/etc/systemd/system/sharlie-meshtastic-daemon.service`
accordingly, then run `sudo systemctl daemon-reload`.

Check logs:

```bash
sudo journalctl -u sharlie-meshtastic-daemon -f
```

### Updating

```bash
cd ~/sharlie-signalk && git pull
~/sharlie-signalk/daemon/.venv/bin/pip install -r ~/sharlie-signalk/daemon/requirements.txt
sudo systemctl restart sharlie-meshtastic-daemon
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MESHTASTIC_HOST` | `192.168.8.105` | Meshtastic radio IP (TCP) |
| `MESHTASTIC_PORT` | `4403` | Meshtastic TCP port |
| `MESHTASTIC_CHANNEL` | `1` | Sharlie channel index |
| `SIGNALK_URL` | `http://localhost:3000` | SignalK server base URL |
| `TRIGGER_PHRASE` | `boat info` | Text that triggers a reply |
| `LOG_LEVEL` | `INFO` | Python log level |

## Notes

- Replies are split to stay under Meshtastic's ~200 byte text limit.
- The daemon uses SignalK's REST API (`/signalk/v1/api/vessels/self`), so N2K data must already be flowing into SignalK.
- Meshtastic must be reachable over TCP from the Pi (same as `meshtastic --host ...`).
