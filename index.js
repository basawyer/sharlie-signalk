module.exports = function (app) {
  const plugin = {};

  // Fixed poll interval for both bilge and fresh water logic
  const POLL_MS = 1000;
  const STATE_FILE = 'sharlie-plugin-state.json';

  // Hard-coded paths for bilge pump
  const BILGE_STATE_PATH = 'electrical.bilgePump.state';
  const BILGE_NOTIFICATION_PATH = 'notifications.electrical.bilgePump';

  // Hard-coded paths for fresh water usage
  const FRESH_WATER_STATE_PATH = 'electrical.freshWaterPump.state';
  const FRESH_WATER_ALLTIME_SECONDS_PATH =
    'tanks.freshWater.usage.allTime.seconds';
  const FRESH_WATER_ALLTIME_OUNCES_PATH =
    'tanks.freshWater.usage.allTime.ounces';
  const FRESH_WATER_CURRENT_SECONDS_PATH =
    'tanks.freshWater.usage.currentSeconds';
  const FRESH_WATER_CURRENT_OUNCES_PATH =
    'tanks.freshWater.usage.currentOunces';

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
  // Current (non-persisted) fresh water usage
  let currentFreshWater = {
    currentOunces: 0,
    currentSeconds: 0
  };
  plugin.schema = {
    type: 'object',
    title: 'Sharlie bilge and fresh water monitoring',
    description:
      'Monitors a bilge pump GPIO and a fresh water pump GPIO, publishing state and usage to Signal K.',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable Sharlie plugin',
        description: 'Turn the Sharlie plugin on or off.',
        default: true
      },
      gpiochip: {
        type: 'string',
        title: 'GPIO chip device',
        description:
          'Linux gpiochip device name used for both bilge and fresh water pumps.',
        default: 'gpiochip0'
      },
      bilge: {
        type: 'object',
        title: 'Bilge pump',
        description:
          'Configuration for the bilge pump GPIO and its alarm notification.',
        properties: {
          gpio: {
            type: 'number',
            title: 'Bilge pump GPIO',
            description:
              'GPIO pin number connected to the bilge pump (active-low, 0 = ON).',
            default: 27
          }
        }
      },
      freshWater: {
        type: 'object',
        title: 'Fresh water pump',
        description:
          'Configuration for the fresh water pump and derived usage metrics.',
        properties: {
          gpio: {
            type: 'number',
            title: 'Fresh water pump GPIO',
            description:
              'GPIO pin number connected to the fresh water pump (active-low, 0 = ON).',
            default: 24
          },
          ouncesPerSecond: {
            type: 'number',
            title: 'Flow rate (oz/s)',
            description:
              'Estimated fresh water flow rate in ounces per second while the pump is ON.',
            default: 0
          },
          resetCurrentUsage: {
            type: 'boolean',
            title: 'Reset current fresh water usage now',
            description:
              'When enabled and settings are saved, currentSeconds and currentOunces will be reset to 0 (non-persisted).',
            default: false
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

      // Always use bias pull-up and active-low logic
      args.push('--bias=pull-up');

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

  // All inputs (bilge and fresh water) are wired active-low (0 means ON)
  async function readInput(options, gpio) {
    const rawHigh = await execGpioget(options, gpio);
    return !rawHigh;
  }

  function handleBilge(input, isOn) {
    const key = 'bilge';
    const prev = lastStates[key];

    if (prev === undefined || prev !== isOn) {
      if (isOn) {
        setNotification(BILGE_NOTIFICATION_PATH, 'Bilge Pump is ON');
      } else {
        clearNotification(BILGE_NOTIFICATION_PATH);
      }
    }

    publishValue(BILGE_STATE_PATH, isOn);
    lastStates[key] = isOn;
  }

  function handleFreshWater(options, isOn) {
    const cfg = options.freshWater;

    if (lastStates.freshWater !== isOn) {
      publishValue(FRESH_WATER_STATE_PATH, isOn);
      lastStates.freshWater = isOn;
    }

    if (isOn) {
      const secondsIncrement = POLL_MS / 1000;
      const ouncesIncrement = Number(cfg.ouncesPerSecond || 0) * secondsIncrement;

      state.freshWater.allTimeTotalSeconds += secondsIncrement;
      state.freshWater.allTimeTotalOunces += ouncesIncrement;
      currentFreshWater.currentSeconds += secondsIncrement;
      currentFreshWater.currentOunces += ouncesIncrement;

      publishValue(
        FRESH_WATER_ALLTIME_SECONDS_PATH,
        state.freshWater.allTimeTotalSeconds
      );
      publishValue(
        FRESH_WATER_ALLTIME_OUNCES_PATH,
        state.freshWater.allTimeTotalOunces
      );
      publishValue(
        FRESH_WATER_CURRENT_SECONDS_PATH,
        currentFreshWater.currentSeconds
      );
      publishValue(
        FRESH_WATER_CURRENT_OUNCES_PATH,
        currentFreshWater.currentOunces
      );

      saveState();
    }
  }

  async function pollOnce(options) {
    // Bilge pump
    if (options.bilge && options.bilge.gpio != null) {
      try {
        const bilgeIsOn = await readInput(options, options.bilge.gpio);
        handleBilge({ gpio: options.bilge.gpio }, bilgeIsOn);
      } catch (err) {
        app.error(err.message);
      }
    }

    // Fresh water pump
    const freshWaterCfg = options.freshWater;
    if (!freshWaterCfg || freshWaterCfg.gpio == null) {
      return;
    }

    try {
      const freshWaterIsOn = await readInput(options, freshWaterCfg.gpio);
      handleFreshWater(options, freshWaterIsOn);
    } catch (err) {
      app.error(err.message);
    }
  }

  plugin.start = function (options) {
    lastStates = {};
    currentFreshWater = {
      currentOunces: 0,
      currentSeconds: 0
    };
    loadState();

    if (!options || options.enabled === false) {
      app.debug('Sharlie plugin disabled (enabled=false)');
      return;
    }

    if (options.freshWater) {
      // Optionally reset current usage when requested from settings
      if (options.freshWater.resetCurrentUsage) {
        currentFreshWater.currentOunces = 0;
        currentFreshWater.currentSeconds = 0;
      }

      publishValue(FRESH_WATER_STATE_PATH, false);
      publishValue(
        FRESH_WATER_ALLTIME_SECONDS_PATH,
        state.freshWater.allTimeTotalSeconds
      );
      publishValue(
        FRESH_WATER_ALLTIME_OUNCES_PATH,
        state.freshWater.allTimeTotalOunces
      );
      publishValue(
        FRESH_WATER_CURRENT_SECONDS_PATH,
        currentFreshWater.currentSeconds
      );
      publishValue(
        FRESH_WATER_CURRENT_OUNCES_PATH,
        currentFreshWater.currentOunces
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
