// 定时同步调度：每 60s 检查一次，命中 hourly / daily 规则则触发同步
"use strict";
const sync = require("./sync.cjs");

let timer = null;
let lastHourlyAt = 0;
let lastDailyAt = ""; // "YYYY-MM-DD"
let paused = false;

function setPaused(v) {
  paused = !!v;
}

function isPaused() {
  return paused;
}

/** 命中判断 + 触发，返回是否触发 */
function shouldRun(cfg) {
  if (!cfg.schedule) return false;
  const now = Date.now();

  // 每小时
  if (cfg.schedule.hourly) {
    const interval = Math.max(1, cfg.schedule.hourlyInterval || 1);
    if (now - lastHourlyAt >= interval * 60 * 60 * 1000) {
      lastHourlyAt = now;
      return true;
    }
  }

  // 每天固定时间
  if (cfg.schedule.daily && cfg.schedule.dailyTime) {
    const [h, m] = cfg.schedule.dailyTime.split(":").map((x) => parseInt(x, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const d = new Date(now);
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (today !== lastDailyAt && d.getHours() === h && d.getMinutes() === m) {
        lastDailyAt = today;
        return true;
      }
    }
  }
  return false;
}

function getConfig() {
  // 延迟 require 避免循环依赖
  const config = require("./config.cjs");
  return config.loadConfig();
}

function tick() {
  try {
    if (paused) return;
    const cfg = getConfig();
    if (shouldRun(cfg) && !sync.progress().running) {
      sync.run(cfg).catch(() => {});
    }
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 60 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, setPaused, isPaused };
