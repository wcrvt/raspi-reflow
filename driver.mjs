import spi from'pi-spi';
import gpio_pkg from 'rpi-gpio';
const {promise: gpio} = gpio_pkg;

// raspi allow us to use /dev/spidev0.0  /dev/spidev1. (can be confirmed by ls /dev/spi*)
// It depends on "/boot/config.txt", I set it at 2023/04/27 as follow:
// dtoverlay=spi0-1cs,cs0_pin=8
// dtoverlay=spi1-1cs,cs0_pin=7
// This configuration should be set following to the wiring on the board.
const SPI_DEVS = {ch0: '/dev/spidev0.0', ch1: '/dev/spidev1.0'};
const SPI_SPEED = 5e6;
const SPI_BITORDER = spi.order.MSB_FIRST;

const GPIO_CHANNELS = [3, 5];
const GPIO_NUM = GPIO_CHANNELS.length;
const MAX31855_MISODATASIZE = 4;
const MAX31855_EXTTEMPCONFIG = { mask: 0x7ffc0000, shift: 18, gain: 0.25};
const MAX31855_INTTEMPCONFIG = { mask: 0x0000fff0, shift: 4, gain: 0.0625};

const CNT_APPROVED = 3;

const ROC_STAT = ['PREHEATING', 'FLUXACTIVATION', 'MAINHEATING', 'RESIDUALHEATING'];
const ROC_STAGENUM = ROC_STAT.length;
const ROC_PARAM = {
  PREHEATING: {THRESHOLD_TEMP: 120.0, TIMELIMIT: 0, PWMCYCLE: 10, PWMON: 10, DISSIPATION_DETECT: false},
  FLUXACTIVATION: {THRESHOLD_TEMP: 170.0, TIMELIMIT: 80.0, PWMCYCLE: 3, PWMON: 1, DISSIPATION_DETECT: false},
  MAINHEATING: {THRESHOLD_TEMP: 225.0, TIMELIMIT: 0, PWMCYCLE: 10, PWMON: 10, DISSIPATION_DETECT: false},
  RESIDUALHEATING: {THRESHOLD_TEMP: 240.0, TIMELIMIT: 0, PWMCYCLE: 10, PWMON: 0, DISSIPATION_DETECT: true},
};

//RaspiReflowOvenControlBoard
class RaspiROC {
  constructor(spiDev, spiSpeed, spiBitOrder) {
    // Board
    this.spidev = spi.initialize(spiDev);
    this.spidev.clockSpeed(spiSpeed);
    this.spidev.bitOrder(spiBitOrder);
    // Temperature
    this.tempExt = 0.0;
    this.tempInt = 0.0;
    this.tempExtZ1 = null;
    this.tempExtDiff = null;
    this.tempExtData = [];
    // Reflow parameter
    this.ctask = null;
    this.stm = 0;
    this.isHeating = false;
    this.finish = false;
    this.cnt = 0;
    this.timer = 0;
    this.timecnt = 0;
    this.pwmcnt = 0;
  };

  setup = async _ => {
    await Promise.all(GPIO_CHANNELS.map(async pin => await gpio.setup(pin, gpio.DIR_OUT)));
    this.reset();
  };

  close = _ => {
    this.ssr_deactivate();
    this.stopReflowTask();
    gpio.destroy();
    this.spidev.close();
  };

  reset = _ => {
    this.ssr_deactivate();
    this.stopReflowTask();
    this.resetRetainedData();
  };

  resetLocalTimers = _ => {
    this.cnt = 0;
    this.timecnt = 0;
    this.pwmcnt = 0;
  };

  resetAllTimers = _ => {
    this.timer = 0;
    this.resetLocalTimers();
  };

  resetRetainedData = _ => {
    // Temperature
    this.tempExt = 0.0;
    this.tempInt = 0.0;
    this.tempExtZ1 = null;
    this.tempExtDiff = null;
    this.tempExtData = [];
  };

  stopReflowTask = _ => {
    if (this.ctask !== null) clearInterval(this.ctask);
    this.ctask = null;
    this.ssr_deactivate();
    this.resetAllTimers();
    this.stm = 0;
    this.isHeating = false;
    this.finish = false;
  };

  ssr_switch = (ch = -1, ena = false) => {
    if (ch < 0 || ch > GPIO_NUM) for (let i = 0; i < GPIO_NUM; i++) gpio.write(GPIO_CHANNELS[i], ena);
    else gpio.write(GPIO_CHANNELS[ch], true);
  };

  ssr_deactivate = _ => this.ssr_switch(-1, false);

  read = async _ => {
    return new Promise((resolve, reject) => {
      this.spidev.read(MAX31855_MISODATASIZE, (err, data) => {
        if (err) reject(err);
        const recv = data.readUInt32BE();
        this.tempExtZ1 = this.tempExt;
        this.tempExt = ((recv & MAX31855_EXTTEMPCONFIG.mask) >> MAX31855_EXTTEMPCONFIG.shift) * MAX31855_EXTTEMPCONFIG.gain;
        this.tempInt = ((recv & MAX31855_INTTEMPCONFIG.mask) >> MAX31855_INTTEMPCONFIG.shift) * MAX31855_INTTEMPCONFIG.gain;
        this.tempExtDiff = (this.tempExt && this.tempExtZ1)? this.tempExt - this.tempExtZ1 : null;
        resolve({external: this.tempExt, internal: this.tempInt});
      });
    });
  };

  reflow = (ts_ms = 1000) => {
    const ts = ts_ms * 1e-3;
    this.stm = 1;
    this.finish = false;
    this.tempExtData = [];
    this.resetAllTimers();

    this.ctask = setInterval(async () => {
      const temp = await this.read();

      this.tempExtData.push({time: this.timer, temp: temp.external});
      this.timer += ts;

      console.log(this.timer, this.stm, this.tempExt);

      if (this.stm >= 1 && this.stm <= ROC_STAGENUM) {
        const stage = ROC_STAT[this.stm - 1];
        const param = ROC_PARAM[stage];

        this.timecnt++;
        const isTimerover = param.TIMELIMIT > 0 && this.timecnt * ts > param.TIMELIMIT;
        const isHeatDissipatedDetected = param.DISSIPATION_DETECT && this.tempExtDiff < 0.0;

        this.cnt = (this.tempExt > param.THRESHOLD_TEMP || isHeatDissipatedDetected)? this.cnt + 1 : this.cnt;
        this.pwmcnt = (this.pwmcnt < param.PWMCYCLE - 1)? this.pwmcnt + 1 : 0;
        this.isHeating = this.pwmcnt < param.PWMON;
        this.ssr_switch(-1, this.isHeating);

        if (this.cnt >= CNT_APPROVED || isTimerover) {
          this.resetLocalTimers();
          this.stm++;
        };

      } else if (this.stm > ROC_STAGENUM) {
        this.ssr_deactivate();
        this.resetAllTimers();
        this.stopReflowTask();
        this.stm = 0;
        this.finish = true;
      };
    }, ts_ms);
  };
};

export default new RaspiROC(SPI_DEVS.ch0, SPI_SPEED, SPI_BITORDER);
