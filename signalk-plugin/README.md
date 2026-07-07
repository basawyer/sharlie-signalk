# Sharlie SignalK Plugin

SignalK plugin for SV Sharlie. Monitors bilge and fresh water pump GPIO inputs and forwards boat alarm notifications to Meshtastic.

## Install

On the Pi running SignalK:

```bash
cd ~/.signalk/node_modules
git clone https://github.com/basawyer/sharlie-signalk.git sharlie-plugin
cd sharlie-plugin/signalk-plugin
npm install
```

Or symlink the `signalk-plugin` directory into `~/.signalk/node_modules/sharlie-plugin` and point SignalK at `index.js`.

Enable the plugin in the SignalK admin UI under **Server → Plugin Config → Sharlie Plugin**.

## Requirements

- `gpioget` (from `gpiod` tools) on the host
- Meshtastic CLI reachable if using alarm forwarding
