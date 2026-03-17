module.exports = function (app) {
  const plugin = {};

  plugin.id = 'sharlie-plugin';
  plugin.name = 'Sharlie Plugin';
  plugin.description = 'Sharlie on signal-k';

  const { execFile } = require('child_process');

  let intervalHandle = null;
  let lastStates = {};      
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
            notifyOnState: false,          }
        ]
      }
    }
  };

  function log(...args) {
    app.debug(...args);
  }

    function clearNotification(path) {
    if (!path) return;
    try {
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              {
                path,
                value: null
              }
            ]
          }
        ]
      });
    } catch (err) {
      app.error(`Failed clearing notification ${path}: ${err.message}`);
    }
  }

  function setNotification(path, state, message, method = ['visual', 'sound']) {
    if (!path) return;
    try {
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              {
                path,
                value: {
                  state,
                  message,
                  method,
                  timestamp: new Date().toISOString()
                }
              }
            ]
          }
        ]
      });
    } catch (err) {
      app.error(`Failed setting notification ${path}: ${err.message}`);
    }
  }

  function publishValue(path, value) {
    if (!path) return;
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path,
              value
            }
          ]
        }
      ]
    });
  }

  function execGpioget(options, gpio) {
    return new Promise((resolve, reject) => {
      const args = [];
      if (options.useBiasPullUp) {
        args.push('--bias=pull-up');
      }
      args.push(options.gpiochip, String(gpio));

      execFile('gpioget', args, { timeout: 3000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
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
    const isOn = input.activeLow ? !rawHigh : rawHigh;
    return { rawHigh, isOn };
  }

    function handleTransition(input, isOn) {
    const now = Date.now();
    const prev = lastStates[input.id];

    if (!prev || prev.isOn !== isOn) {
      if (isOn) {
        if (input.notifyOnState) {
          setNotification(input.notificationPath, 'alarm', `${input.label || input.id} is ON`);
        }
      } else {        clearNotification(input.notificationPath);      }
    }

    publishValue(input.statePath, isOn);
    lastStates[input.id] = { isOn, at: now };
  }

    async function pollOnce(options) {
    for (const input of options.inputs || []) {
      if (!input.enabled) continue;
      try {
        const { isOn } = await readInput(options, input);
        handleTransition(input, isOn);      } catch (err) {
        app.error(`GPIO read failed for ${input.label || input.id} (GPIO ${input.gpio}): ${err.message}`);
      }
    }
  }

  function msUntilNextLocalMidnight() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 5, 0);
    return next.getTime() - now.getTime();
  }

    plugin.start = function (options) {
    log('Starting Sharlie Plugin');    lastStates = {};
    pollOnce(options).catch(err => app.error(err.message));
    intervalHandle = setInterval(() => {
      pollOnce(options).catch(err => app.error(err.message));
    }, options.pollMs || 1000);
  };

  plugin.stop = function () {
    log('Stopping Sharlie Plugin');

    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }    lastStates = {};
  };

  return plugin;
};
