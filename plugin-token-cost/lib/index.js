/**
 * token-cost 插件主进程半。
 * 作为 profile bundle 加载：dsh.bundle.patch 指向 cordis.patch.yml，
 * 由该补丁把自己的 host 行插入组合树；浏览器半走 dsh.client 声明。
 */
/** Host plugin body — 无 host 侧行为。 */
function apply(ctx) {
  // 激活标记：便于确认插件条目被 loader 加载
  console.log('[token-cost] host plugin activated');
}

export { apply };
