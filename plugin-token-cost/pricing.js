'use strict';

/**
 * DeepSeek V4 峰谷计价模块（纯计算，不依赖 DSH/Electron，便于单测）。
 *
 * 价格来源：DeepSeek 官方公告，2026-08-17 起生效（V4 系列首次采用峰谷分级计价）。
 * 单位：人民币 元 / 百万 tokens（¥/M tokens）。
 * 高峰时段 = 每日 9:00-14:00（北京时间），其余为空闲时段；高峰 = 空闲 × 2。
 *
 * 参考：
 * - https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * - 媒体报道：https://news.qq.com/rain/a/20260817V03S1500
 *   （DeepSeek-V4-Flash：空闲 输入缓存命中 ¥0.05 / 未命中 ¥1.5 / 输出 ¥4.5；
 *     高峰 命中 ¥0.10 / 未命中 ¥3.0 / 输出 ¥9.0。
 *     V4-Pro：空闲 命中 ¥0.15 / 未命中 ¥4.5 / 输出 ¥13.5；
 *     高峰 命中 ¥0.30 / 未命中 ¥9.0 / 输出 ¥27.0。）
 */

// 高峰时段（北京时间小时，[start, end)），可按官方后续公告在配置里改
const PEAK_WINDOW = { start: 9, end: 14 };
const BEIJING_UTC_OFFSET = 8;

const PRICING = {
  'deepseek-v4-flash': {
    peak: { inputMiss: 3.0, inputHit: 0.1, output: 9.0 },
    idle: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { inputMiss: 9.0, inputHit: 0.3, output: 27.0 },
    idle: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
};

/**
 * 根据模型名解析定价档位（宽松匹配：v4-pro / v4-flash）。
 * @param {string} model 会话模型名（如 deepseek-v4-flash）
 * @returns {string|null} 定价档位 key
 */
function matchModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('v4-pro') || m.includes('pro')) return 'deepseek-v4-pro';
  if (m.includes('v4-flash') || m.includes('flash')) return 'deepseek-v4-flash';
  if (m.includes('deepseek-chat')) return 'deepseek-v4-flash'; // 旧名兼容
  if (m.includes('deepseek-reasoner')) return 'deepseek-v4-pro';
  return null;
}

/** 北京时间小时（0-23） */
function beijingHour(date = new Date()) {
  return (date.getUTCHours() + BEIJING_UTC_OFFSET) % 24;
}

/** 当前是否为高峰时段（按配置窗口，北京时间） */
function isPeak(date = new Date()) {
  const h = beijingHour(date);
  return h >= PEAK_WINDOW.start && h < PEAK_WINDOW.end;
}

/** 获取某档位在给定时刻的单价（¥/M tokens）；未知模型返回 null */
function rateFor(model, date = new Date()) {
  const key = matchModel(model);
  if (!key) return null;
  return PRICING[key][isPeak(date) ? 'peak' : 'idle'];
}

/**
 * 计算一次用量花费（¥）。
 * @param {string} model 模型名
 * @param {Date|number} date 发生时刻（用于判峰谷）
 * @param {{inputMiss?:number,inputHit?:number,output?:number}} usage token 数
 * @returns {number|null} 花费（¥），未知模型返回 null
 */
function costFor(model, date, usage) {
  const r = rateFor(model, date);
  if (!r) return null;
  const miss = usage.inputMiss ?? usage.input ?? 0;
  const hit = usage.inputHit ?? 0;
  const out = usage.output ?? 0;
  return (miss / 1e6) * r.inputMiss + (hit / 1e6) * r.inputHit + (out / 1e6) * r.output;
}

module.exports = { PRICING, PEAK_WINDOW, BEIJING_UTC_OFFSET, matchModel, beijingHour, isPeak, rateFor, costFor };
