module.exports = function (app) {
  const plugin = {};

  const POLL_MS = 250;
  const STATE_FILE = 'sharlie-plugin-state.json';

  plugin.id = 'sharlie-plugin';
  plugin.name = 'Sharlie Plugin';
  plugin.description = 'Sharlie on signal-k';

  const { execFile } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  let intervalHandle = null;
  let lastStates = {};      
  let state = {
          freshWater: {
            allTimeTotalOunces: 0,
            allTimeTotalSeconds: 0
          }
        };
  plugin.schema = {
    type: 'object',
    properties: {
      pollMs: {
        type: 'number',
        title: 'Poll interval (ms)',
        default: 1000,
        minimum: 200
      },
      gpiochip: {
        type: 'string',
        title: 'GPIO chip',
        default: 'gpiochip0'
      },
      useBiasPullUp: {
        type: 'boolean',
        title: 'Use --bias=pull-up with gpioget',
        default: true
      },
      inputs: {
        type: 'array',
        title: 'Inputs',
        items: {
          type: 'object',
          required: ['id', 'gpio', 'statePath'],
          properties: {
            id: {
              type: 'string',
              title: 'ID',
              default: 'bilge1'
            },
            enabled: {
              type: 'boolean',
              title: 'Enabled',
              default: true
            },
            label: {
              type: 'string',
              title: 'Label',
              default: 'Bilge Pump'
            },
            gpio: {
              type: 'number',
              title: 'GPIO number',
              default: 27
            },
            activeLow: {
              type: 'boolean',
              title: 'Active low (0 means ON)',
              default: true
            },
            statePath: {
              type: 'string',
              title: 'Signal K state path',
              default: 'electrical.bilgePump.state'
            },
            notificationPath: {
              type: 'string',
              title: 'Notification path',
              default: 'notifications.electrical.bilgePump'
            },
            notifyOnState: {
              type: 'boolean',
              title: 'Raise notification while ON',
              default: true
            }
          }
        },
        default: [
          {
            id: 'bilge',
            enabled: true,
            label: 'Bilge Pump',
            gpio: 27,
            activeLow: true,
            statePath: 'electrical.bilgePump.state',
            notificationPath: 'notifications.electrical.bilgePump',
            notifyOnState: false
          }
        ]
      },
      freshWater: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            default: true
          },
          label: {
            type: 'string',
            default: 'Fresh Water Pump'
          },
          gpio: {
            type: 'number',
            default: 24
          },
          activeLow: {
            type: 'boolean',
            default: true
          },
          ouncesPerSecond: {
            type: 'number',
            default: 0
          },
          statePath: {
            type: 'string',
            default: 'electrical.freshWaterPump.state'
          },
          allTimeTotalOuncesPath: {
            type: 'string',
            default: 'tanks.freshWater.usage.allTimeOunces'
          },
          allTimeTotalSecondsPath: {
            type: 'string',
            default: 'tanks.freshWater.usage.allTimeSeconds'
          }
        }
      }
    }
  };

  function loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state = {
          freshWater: {
            allTimeTotalOunces: Number(
              loaded &&
                loaded.freshWater &&
                loaded.freshWater.allTimeTotalOunces || 0
            ),
            allTimeTotalSeconds: Number(
              loaded &&
                loaded.freshWater &&
                loaded.freshWater.allTimeTotalSeconds || 0
            )
          }
        };
      }
    } catch (err) {
      app.error(`Failed loading state: ${err.message}`);
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      app.error(`Failed saving state: ${err.message}`);
    }
  }

  function publishValue(pathValue, value) {
    if (!pathValue) {
      return;
    }

    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: pathValue,
              value: value
            }
          ]
        }
      ]
    });
  }

  function clearNotification(pathValue) {
    if (!pathValue) {
      return;
    }

    publishValue(pathValue, null);
  }

  function setNotification(pathValue, message) {
    if (!pathValue) {
      return;
    }

    publishValue(pathValue, {
      state: 'alarm',
      message: message,
      timestamp: new Date().toISOString()
    });
  }

  function execGpioget(options, gpio) {
    return new Promise((resolve, reject) => {
      const args = [];

      if (options.useBiasPullUp) {
        args.push('--bias=pull-up');
      }

      args.push(options.gpiochip, String(gpio));

      execFile('gpioget', args, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr && stderr.trim()) || err.message));
          return;
        }

        const out = stdout.trim();

        if (out !== '0' && out !== '1') {
          reject(new Error(`Unexpected gpioget output for GPIO ${gpio}: ${out}`));
          return;
        }

        resolve(out === '1');
      });
    });
  }

  async function readInput(options, input) {
    const rawHigh = await execGpioget(options, input.gpio);
    return input.activeLow ? !rawHigh : rawHigh;
  }

  function handleBilge(input, isOn) {
    const prev = lastStates[input.id];

    if (prev === undefined || prev !== isOn) {
      if (isOn && input.notifyOnState) {
        setNotification(input.notificationPath, `${input.label} is ON`);
      } else {
        clearNotification(input.notificationPath);
      }
    }

    publishValue(input.statePath, isOn);
    lastStates[input.id] = isOn;
  }

  function handleFreshWater(options, isOn) {
    const cfg = options.freshWater;

    if (!cfg || !cfg.enabled) {
      return;
    }

    if (lastStates.freshWater !== isOn) {
      publishValue(cfg.statePath, isOn);
      lastStates.freshWater = isOn;
    }

    if (isOn) {
      const secondsIncrement = POLL_MS / 1000;
      const ouncesIncrement = Number(cfg.ouncesPerSecond || 0) * secondsIncrement;

      state.freshWater.allTimeTotalSeconds += secondsIncrement;
      state.freshWater.allTimeTotalOunces += ouncesIncrement;

      publishValue(
        cfg.allTimeTotalSecondsPath,
        state.freshWater.allTimeTotalSeconds
      );
      publishValue(
        cfg.allTimeTotalOuncesPath,
        state.freshWater.allTimeTotalOunces
      );

      saveState();
    }
  }

  async function pollOnce(options) {
    for (const input of options.inputs || []) {
      if (!input.enabled) {
        continue;
      }

      try {
        const isOn = await readInput(options, input);
        handleBilge(input, isOn);
      } catch (err) {
        app.error(err.message);
      }
    }

    if (options.freshWater && options.freshWater.enabled) {
      try {
        const isOn = await readInput(options, {
          gpio: options.freshWater.gpio,
          activeLow: options.freshWater.activeLow
        });

        handleFreshWater(options, isOn);
      } catch (err) {
        app.error(err.message);
      }
    }
  }

  plugin.start = function (options) {
    lastStates = {};
    loadState();

    if (options.freshWater && options.freshWater.enabled) {
      publishValue(options.freshWater.statePath, false);
      publishValue(
        options.freshWater.allTimeTotalSecondsPath,
        state.freshWater.allTimeTotalSeconds
      );
      publishValue(
        options.freshWater.allTimeTotalOuncesPath,
        state.freshWater.allTimeTotalOunces
      );
    }

    intervalHandle = setInterval(() => {
      pollOnce(options).catch((err) => app.error(err.message));
    }, POLL_MS);
  };

  plugin.stop = function () {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    saveState();
  };

  return plugin;
};
