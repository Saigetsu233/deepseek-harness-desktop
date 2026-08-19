window.__ModuleLoader__.load({
	id: "token-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── DeepSeek V4 峰谷计价（2026-08-17 官方公告）──────────────────────────
		// 单位：¥ / 百万 tokens。高峰时段 = 每日 9:00-14:00（北京时间），价格为空闲的 2 倍。
		const PRICING = {
			"deepseek-v4-flash": {
				peak: { inputMiss: 3.0, inputHit: 0.1, output: 9.0 },
				idle: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }
			},
			"deepseek-v4-pro": {
				peak: { inputMiss: 9.0, inputHit: 0.3, output: 27.0 },
				idle: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 }
			}
		};
		const PEAK_WINDOW = { start: 9, end: 14 };
		const BEIJING_OFFSET = 8;
		function matchModel(m) {
			const s = String(m || "").toLowerCase();
			if (s.includes("v4-pro") || s.includes("pro")) return "deepseek-v4-pro";
			if (s.includes("v4-flash") || s.includes("flash")) return "deepseek-v4-flash";
			if (s.includes("deepseek-chat")) return "deepseek-v4-flash";
			if (s.includes("deepseek-reasoner")) return "deepseek-v4-pro";
			return null;
		}
		function beijingHour(d) { return (d.getUTCHours() + BEIJING_OFFSET) % 24; }
		function isPeak(d) { const h = beijingHour(d); return h >= PEAK_WINDOW.start && h < PEAK_WINDOW.end; }
		function beijingDayKey(d) { return new Date(d.getTime() + BEIJING_OFFSET * 3600e3).toISOString().slice(0, 10); }
		function rateFor(model, d) {
			const k = matchModel(model);
			return k ? PRICING[k][isPeak(d) ? "peak" : "idle"] : null;
		}

		// ── 账本（localStorage 持久化，按北京时间分天 + 高峰/低谷分桶）─────────────
		const LS_KEY = "token-cost-ledger-v2";
		let ledger = loadLedger();
		const listeners = new Set();
		function emptyLedger() { return { sessions: {}, days: {} }; }
		function loadLedger() {
			try {
				const v = JSON.parse(localStorage.getItem(LS_KEY));
				if (v && v.days && v.sessions) return v;
			} catch (e) { /* 忽略损坏数据 */ }
			return emptyLedger();
		}
		function saveLedger() {
			try { localStorage.setItem(LS_KEY, JSON.stringify(ledger)); } catch (e) { /* 存储满/禁用时忽略 */ }
		}
		function commit() {
			saveLedger();
			for (const l of listeners) { try { l(); } catch (e) { /* 忽略 */ } }
		}
		function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

		// ── 轮询：会话 token 增量 → 按当前时刻峰谷计价入账 ───────────────────────
		const POLL_MS = 8000;
		function emptyBucket() { return { inputMiss: 0, inputHit: 0, output: 0, cost: 0 }; }

		async function fetchModel(api, sessionId) {
			try {
				const { result } = await api.sessions.models({ sessionId });
				if (result && result.ok) return result.value?.current?.model || null;
			} catch (e) { /* 忽略 */ }
			return null;
		}

		async function poll(api) {
			try {
				const { result } = await api.sessions.list({});
				if (!result || !result.ok || !result.value) return;
				const now = new Date();
				const peak = isPeak(now);
				const dayKey = beijingDayKey(now);
				let changed = false;
				const day = ledger.days[dayKey] || (ledger.days[dayKey] = { peak: emptyBucket(), idle: emptyBucket(), byModel: {} });
				for (const item of result.value.items) {
					const usage = item.projections?.values?.tokenUsage;
					if (!usage) continue;
					const sid = item.sessionId;
					const u = {
						miss: usage.uncachedInputTokens || 0,
						hit: usage.cacheReadTokens || 0,
						out: usage.outputTokens || 0
					};
					const prev = ledger.sessions[sid];
					if (prev && (u.miss < prev.miss || u.hit < prev.hit || u.out < prev.out)) {
						// 会话被压缩/重建：以当前值重新起算，不产生增量
						ledger.sessions[sid] = { miss: u.miss, hit: u.hit, out: u.out, model: prev.model };
						changed = true;
						continue;
					}
					if (!prev) {
						// 首次见到该会话：只建立基线，不计费
						// （其历史用量发生在插件安装/账本初始化之前，不该算进今天的花费）
						ledger.sessions[sid] = { miss: u.miss, hit: u.hit, out: u.out, model: null };
						changed = true;
						continue;
					}
					const dMiss = u.miss - prev.miss;
					const dHit = u.hit - prev.hit;
					const dOut = u.out - prev.out;
					ledger.sessions[sid] = { miss: u.miss, hit: u.hit, out: u.out, model: prev.model };
					if (dMiss + dHit + dOut <= 0) continue;
					let model = ledger.sessions[sid].model;
					if (!model) { model = await fetchModel(api, sid); ledger.sessions[sid].model = model; }
					const rate = rateFor(model, now);
					const cost = rate
						? (dMiss / 1e6) * rate.inputMiss + (dHit / 1e6) * rate.inputHit + (dOut / 1e6) * rate.output
						: 0;
					const bucket = day[peak ? "peak" : "idle"];
					bucket.inputMiss += dMiss; bucket.inputHit += dHit; bucket.output += dOut; bucket.cost += cost;
					const mk = matchModel(model) || "other";
					const m = day.byModel[mk] || (day.byModel[mk] = emptyBucket());
					m.inputMiss += dMiss; m.inputHit += dHit; m.output += dOut; m.cost += cost;
					changed = true;
				}
				if (changed) commit();
			} catch (e) { /* 轮询失败静默，下轮再试 */ }
		}

		// ── 展示组件 ───────────────────────────────────────────────────────────
		const NS = "token-cost";
		const zh = {
			"cost.nav": "费用统计",
			"cost.title": "Token 费用统计",
			"cost.today": "今日花费",
			"cost.peak": "高峰",
			"cost.idle": "低谷",
			"cost.week": "最近 7 天",
			"cost.byModel": "按模型",
			"cost.model": "模型",
			"cost.inputMiss": "输入(未命中)",
			"cost.inputHit": "输入(缓存命中)",
			"cost.output": "输出",
			"cost.cost": "费用(¥)",
			"cost.tokens": "Token 合计",
			"cost.saved": "缓存命中约省",
			"cost.unknown": "（未知模型不计费）",
			"cost.note": "价格按 DeepSeek 官方 2026-08-17 公告：高峰 9:00–14:00（北京时间）为空闲价 2 倍；按北京时间每日累计，数据存于本机浏览器。"
		};
		const en = {
			"cost.nav": "Token Cost",
			"cost.title": "Token Cost",
			"cost.today": "Today",
			"cost.peak": "Peak",
			"cost.idle": "Off-peak",
			"cost.week": "Last 7 days",
			"cost.byModel": "By model",
			"cost.model": "Model",
			"cost.inputMiss": "Input (miss)",
			"cost.inputHit": "Input (cache hit)",
			"cost.output": "Output",
			"cost.cost": "Cost (¥)",
			"cost.tokens": "Tokens",
			"cost.saved": "Saved via cache",
			"cost.unknown": "(unknown models not billed)",
			"cost.note": "Pricing per DeepSeek official announcement 2026-08-17: peak 9:00–14:00 (Beijing) = 2× off-peak; daily totals in Beijing time, stored locally in this browser."
		};

		function fmt(v, digits) {
			if (!Number.isFinite(v)) return "—";
			return v.toLocaleString("zh-CN", { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 2 });
		}
		function fmtTokens(v) {
			if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
			if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
			return String(v);
		}

		function el(tag, props, ...children) {
			return react.createElement(tag, props, ...children);
		}

		const card = {
			background: "var(--dsw-alias-bg-layer-2)",
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: 10,
			padding: "12px 14px",
			marginBottom: 12
		};
		const title = { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: "0 0 10px" };
		const big = { fontSize: 26, fontWeight: 700, color: "var(--dsw-alias-brand-primary)", margin: 0 };
		const label = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "2px 0 0" };
		const row = { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, color: "var(--dsw-alias-label-primary)", borderBottom: "1px solid var(--dsw-alias-border-l1)" };
		const note = { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6, margin: "10px 0 0" };
		const cell = { padding: "4px 8px", textAlign: "right", fontSize: 12, color: "var(--dsw-alias-label-primary)" };
		const cellL = { padding: "4px 8px", textAlign: "left", fontSize: 12, color: "var(--dsw-alias-label-primary)" };
		const head = { ...cellL, color: "var(--dsw-alias-label-tertiary)", fontWeight: 500 };

		function CostSection(props) {
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => subscribe(() => setTick((n) => n + 1)), []);
			const t = props.t ?? ((k) => k);
			const now = new Date();
			const dayKey = beijingDayKey(now);
			const day = ledger.days[dayKey];
			const peakCost = day?.peak?.cost || 0;
			const idleCost = day?.idle?.cost || 0;
			const totalCost = peakCost + idleCost;
			const totalTokens = (day ? day.peak.inputMiss + day.peak.inputHit + day.peak.output + day.idle.inputMiss + day.idle.inputHit + day.idle.output : 0);
			// 缓存命中节省 ≈ 命中 token × (未命中价 - 命中价)
			let saved = 0;
			if (day) {
				const mk = day.peak.inputHit + day.idle.inputHit;
				const miss = day.peak.inputMiss + day.idle.inputMiss + mk;
				saved = (mk / 1e6) * (0.5 * (miss > 0 ? 1 : 0)) * 0; // 占位，下面按模型算
				saved = 0;
				// 简化：只展示 token 数，节省金额按各模型命中价差
				for (const [mk2, b] of Object.entries(day.byModel)) {
					const r = PRICING[mk2];
					if (!r) continue;
					const diff = Math.max(0, (r.peak.inputMiss + r.idle.inputMiss) / 2 - (r.peak.inputHit + r.idle.inputHit) / 2);
					saved += (b.inputHit / 1e6) * diff;
				}
			}
			// 最近 7 天（北京时间日期）
			const week = [];
			for (let i = 0; i < 7; i++) {
				const d = new Date(now.getTime() - i * 86400e3);
				const k = beijingDayKey(d);
				const dcost = (ledger.days[k]?.peak?.cost || 0) + (ledger.days[k]?.idle?.cost || 0);
				week.push({ k, cost: dcost });
			}
			week.reverse();
			const modelRows = day ? Object.entries(day.byModel) : [];

			return el("div", { style: { padding: "2px 0" } },
				el("div", { style: card },
					el("p", { style: title }, t("cost.title")),
					el("div", { style: { display: "flex", alignItems: "flex-end", gap: 16 } },
						el("div", {},
							el("p", { style: big }, "¥" + fmt(totalCost, 3)),
							el("p", { style: label }, t("cost.today"))
						),
						el("div", {},
							el("p", { style: { ...big, fontSize: 16, color: "var(--dsw-alias-state-warn-primary)" } }, "↑ ¥" + fmt(peakCost, 3)),
							el("p", { style: label }, t("cost.peak") + " 9:00–14:00")
						),
						el("div", {},
							el("p", { style: { ...big, fontSize: 16, color: "var(--dsw-alias-state-success-primary)" } }, "↓ ¥" + fmt(idleCost, 3)),
							el("p", { style: label }, t("cost.idle"))
						)
					),
					el("p", { style: { ...label, marginTop: 8 } },
						t("cost.tokens") + "：" + fmtTokens(totalTokens) +
						(saved > 0.005 ? "　·　" + t("cost.saved") + " ≈ ¥" + fmt(saved, 2) : "")
					)
				),
				week.some((w) => w.cost > 0) && el("div", { style: card },
					el("p", { style: title }, t("cost.week")),
					el("div", {}, week.map((w) =>
						el("div", { key: w.k, style: row },
							el("span", {}, w.k),
							el("span", {}, w.cost > 0 ? "¥" + fmt(w.cost, 3) : "—")
						)
					))
				),
				modelRows.length > 0 && el("div", { style: card },
					el("p", { style: title }, t("cost.byModel")),
					el("table", { style: { width: "100%", borderCollapse: "collapse" } },
						el("thead", {},
							el("tr", {},
								el("th", { style: head }, t("cost.model")),
								el("th", { style: head }, t("cost.inputMiss")),
								el("th", { style: head }, t("cost.inputHit")),
								el("th", { style: head }, t("cost.output")),
								el("th", { style: head }, t("cost.cost"))
							)
						),
						el("tbody", {}, modelRows.map(([mk, b]) =>
							el("tr", { key: mk },
								el("td", { style: cellL }, mk === "other" ? "other " + t("cost.unknown") : mk),
								el("td", { style: cell }, fmtTokens(b.inputMiss)),
								el("td", { style: cell }, fmtTokens(b.inputHit)),
								el("td", { style: cell }, fmtTokens(b.output)),
								el("td", { style: cell }, "¥" + fmt(b.cost, 3))
							)
						))
					)
				),
				el("p", { style: note }, t("cost.note"))
			);
		}

		// ── 插件注册 ───────────────────────────────────────────────────────────
		const inject = ["slots", "locale", "connection"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-cost: dictionaries");
			const t = ctx.locale.bind(NS);
			const connection = ctx.get("connection");
			// 全局轮询记账：设置页开不开都在累计
			ctx.effect(() => {
				const run = () => { poll(connection.api).catch(() => {}); };
				run();
				const id = setInterval(run, POLL_MS);
				return () => clearInterval(id);
			}, "token-cost: poll");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "token-cost",
				order: 10,
				label: () => t("cost.nav"),
				locale: NS
			}, CostSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
