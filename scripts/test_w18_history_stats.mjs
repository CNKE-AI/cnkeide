/**
 * W18 历史记录统计看板测试
 * 验证：1) 时间归一与范围过滤  2) 按天聚合（空白天补零）  3) 汇总指标
 *       4) 模型/工具分布  5) 会话明细+筛选+分页  6) 线性回归/移动平均/预测/异常
 *       7) 圆环指标与洞察  8) buildDashboard 端到端
 *
 * 用法：npx tsx scripts/test_w18_history_stats.mjs
 */
import {
  collectDaily, filterRows, filterSessions, hourlyActivity, isToolFailure, modelDistribution,
  NO_WORKSPACE_ID, paginate, rangeStart, sessionRows, summarize, toDayKey, toolDistribution,
  workspaceOptions,
} from '../electron/core-fork/analytics/HistoryStats.js';
import {
  activityScore, buildDashboard, buildInsights, buildKpis, buildTrend, detectAnomalies,
  forecastSeries, formatCompact, linearRegression, movingAverage, peakHour, tailAverage,
} from '../electron/core-fork/analytics/StatsModel.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// 固定"现在"：2026-10-20 12:00 本地时间，避免测试随真实时间漂移
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
const at = (day, hour = 10, minute = 0) => new Date(2026, 9, day, hour, minute, 0).getTime();

/** 构造一条 assistant 消息 */
function aMsg(ts, usage, toolCalls) {
  return { id: `a-${ts}`, role: 'assistant', content: 'ok', timestamp: ts, usage, toolCalls };
}
function uMsg(ts, text) {
  return { id: `u-${ts}`, role: 'user', content: text, timestamp: ts };
}

/** 10-10 ~ 10-20 的会话集合 */
function makeSessions() {
  return [
    {
      id: 's1', title: '重构登录模块', workspaceId: 'C:/proj/a', mode: 'craft',
      createdAt: at(10, 9), updatedAt: at(10, 10),
      messages: [
        uMsg(at(10, 9), '帮我重构登录模块'),
        aMsg(at(10, 9, 1), { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, model: 'glm-4.6', prompt_tokens_details: { cached_tokens: 600 } }, [
          { id: 't1', name: 'read_file', result: { success: true } },
          { id: 't2', name: 'apply_diff', result: { success: false, error: 'conflict' } },
        ]),
        uMsg(at(10, 10), '再补个单测'),
        aMsg(at(10, 10, 1), { prompt_tokens: 2000, completion_tokens: 500, total_tokens: 2500, model: 'glm-4.6' }, [
          { id: 't3', name: 'write_file', result: { success: true } },
        ]),
      ],
    },
    {
      id: 's2', title: '统计面板调研', workspaceId: 'C:/proj/b', mode: 'plan',
      createdAt: at(12, 14), updatedAt: at(12, 15),
      messages: [
        uMsg(at(12, 14), '调研一下可视化方案'),
        aMsg(at(12, 14, 1), { prompt_tokens: 5000, completion_tokens: 1000, total_tokens: 6000, model: 'deepseek-v4-pro' }, [
          { id: 't4', name: 'web_search', result: { success: true } },
          { id: 't5', name: 'web_search', result: { error: 'timeout' } },
        ]),
      ],
    },
    {
      // 老会话：没有任何 usage 字段（验证兜底）
      id: 's3', title: '旧会话无用量', workspaceId: 'C:/proj/a', mode: '',
      createdAt: at(18, 20), updatedAt: at(18, 21),
      messages: [uMsg(at(18, 20), '早期对话'), { id: 'x', role: 'assistant', content: 'hi', timestamp: at(18, 21) }],
    },
    {
      // 超出 30d 范围之外（8 月）
      id: 's4', title: '远古会话', workspaceId: 'C:/proj/a',
      createdAt: new Date(2026, 7, 1, 9).getTime(), updatedAt: new Date(2026, 7, 1, 10).getTime(),
      messages: [uMsg(new Date(2026, 7, 1, 9).getTime(), '八月的事')],
    },
  ];
}

console.log('\n[1] 时间归一与范围过滤');
{
  log(toDayKey(at(10)) === '2026-10-10', 'toDayKey 本地日期', toDayKey(at(10)));
  const s7 = rangeStart('7d', NOW);
  log(toDayKey(s7) === '2026-10-14', '7d 起始日 = 今天-6', toDayKey(s7));
  log(rangeStart('all', NOW) === 0, 'all 范围起始为 0', rangeStart('all', NOW));
  const sessions = makeSessions();
  const r7 = filterSessions(sessions, { range: '7d' }, NOW);
  log(!r7.some((s) => s.id === 's1'), '7d 过滤掉 10-10 的会话', r7.map((s) => s.id).join(','));
  log(r7.some((s) => s.id === 's3'), '7d 保留 10-18 的会话', '');
  const wall = filterSessions(sessions, { range: 'all' }, NOW);
  log(wall.length === 4, 'all 保留全部 4 个会话', `n=${wall.length}`);
  const wsA = filterSessions(sessions, { range: 'all', workspaceId: 'C:/proj/a' }, NOW);
  log(wsA.length === 3, '按工作区过滤', `n=${wsA.length}`);

  // 没打开文件夹就聊天产生的会话 workspaceId 为空：必须能单独筛出来，否则这部分历史在看板上不可达
  const withOrphan = [
    ...sessions,
    { id: 's5', title: '裸聊会话', workspaceId: '', mode: '', createdAt: at(18, 9), updatedAt: at(18, 9), messages: [uMsg(at(18, 9), '你好')] },
  ];
  const orphan = filterSessions(withOrphan, { range: 'all', workspaceId: NO_WORKSPACE_ID }, NOW);
  log(orphan.length === 1 && orphan[0].id === 's5', '可单独筛选未归属工作区', `n=${orphan.length}`);
  log(filterSessions(withOrphan, { range: 'all', workspaceId: 'all' }, NOW).length === 5, '全部工作区仍包含未归属会话', '');
  const kw = filterSessions(sessions, { range: 'all', keyword: '可视化' }, NOW);
  log(kw.length === 1 && kw[0].id === 's2', '关键词命中正文', kw.map((s) => s.id).join(','));
}

console.log('\n[2] 按天聚合');
{
  const sessions = filterSessions(makeSessions(), { range: 'all' }, NOW);
  const daily = collectDaily(sessions, { range: 'all', now: NOW });
  log(daily.length >= 10, '连续日期已补齐', `n=${daily.length}`);
  const d10 = daily.find((p) => p.date === '2026-10-10');
  log(d10 && d10.messages === 4, '10-10 消息数 = 4', `n=${d10?.messages}`);
  log(d10 && d10.userMessages === 2 && d10.assistantMessages === 2, '角色拆分正确', `${d10?.userMessages}/${d10?.assistantMessages}`);
  log(d10 && d10.totalTokens === 3700, '10-10 token = 3700', `n=${d10?.totalTokens}`);
  log(d10 && d10.toolCalls === 3 && d10.toolFailures === 1, '工具调用与失败数', `${d10?.toolCalls}/${d10?.toolFailures}`);
  const empty = daily.find((p) => p.date === '2026-10-15');
  log(empty && empty.messages === 0 && empty.totalTokens === 0, '空白天补 0（趋势不断线）', JSON.stringify(empty));
  const d12 = daily.find((p) => p.date === '2026-10-12');
  log(d12 && d12.sessions === 1, '会话数落在代表日', `sessions=${d12?.sessions}`);
  const days7 = collectDaily(sessions, { range: '7d', now: NOW });
  log(days7.length === 7, '7d 视图固定 7 天', `n=${days7.length}`);
}

console.log('\n[3] 汇总指标');
{
  const sessions = filterSessions(makeSessions(), { range: 'all' }, NOW);
  const daily = collectDaily(sessions, { range: 'all', now: NOW });
  const s = summarize(sessions, daily);
  log(s.sessions === 4, '会话数', `n=${s.sessions}`);
  log(s.messages === 9, '消息总数', `n=${s.messages}`);
  log(s.totalTokens === 9700, 'token 总额', `n=${s.totalTokens}`);
  log(s.cachedTokens === 600 && s.cacheHitRate === 7.5, '缓存命中率 600/8000', `${s.cachedTokens}/${s.cacheHitRate}`);
  log(s.toolCalls === 5 && s.toolFailures === 2 && s.toolFailureRate === 40, '工具失败率 40%', `${s.toolFailures}/${s.toolFailureRate}`);
  log(s.activeDays === 4 && s.spanDays >= 80, '活跃天数/跨度（含 8 月会话）', `${s.activeDays}/${s.spanDays}`);
  log(s.peakDate === '2026-10-12' && s.peakTokens === 6000, '峰值日', `${s.peakDate}/${s.peakTokens}`);
  log(s.avgTokensPerSession === 2425, '会话均值', `n=${s.avgTokensPerSession}`);
  const empty = summarize([], []);
  log(empty.totalTokens === 0 && empty.cacheHitRate === 0, '空输入不炸', JSON.stringify(empty).slice(0, 40));
}

console.log('\n[4] 分布统计');
{
  const sessions = filterSessions(makeSessions(), { range: 'all' }, NOW);
  const models = modelDistribution(sessions);
  log(models.length === 2, '两个模型', models.map((m) => m.model).join(','));
  log(models[0].model === 'deepseek-v4-pro' && models[0].tokens === 6000, '按 token 降序', `${models[0].model}/${models[0].tokens}`);
  log(models[0].share > 0 && models.reduce((a, b) => a + b.share, 0) <= 100.1, '占比合计 ≈100', models.map((m) => m.share).join('+'));
  const tools = toolDistribution(sessions);
  log(tools[0].tool === 'web_search' && tools[0].count === 2, '工具频次排序', `${tools[0].tool}/${tools[0].count}`);
  log(tools.find((t) => t.tool === 'web_search').failures === 1, '工具失败归类', '');
  log(isToolFailure({ result: { error: 'x' } }) && !isToolFailure({ result: { success: true } }), '失败判定', '');
  const hours = hourlyActivity(sessions);
  log(hours.length === 24 && hours[10] >= 2, '24 小时分布', `h10=${hours[10]}`);
  log(peakHour(hours) === 9, '峰值时段 = 9 点（含 8 月同点消息）', `h=${peakHour(hours)}`);
}

console.log('\n[5] 会话明细 + 筛选 + 分页');
{
  const rows = sessionRows(makeSessions());
  log(rows.length === 4, '行数', `n=${rows.length}`);
  const r1 = rows.find((r) => r.id === 's1');
  log(r1.totalTokens === 3700 && r1.toolCalls === 3 && r1.toolFailures === 1, '会话级合计', JSON.stringify({ t: r1.totalTokens, c: r1.toolCalls, f: r1.toolFailures }));
  log(r1.preview.includes('重构登录模块'), '预览取首条用户消息', r1.preview);
  log(r1.models[0] === 'glm-4.6', '模型集合', r1.models.join(','));
  log(r1.durationMs === at(10, 10, 1) - at(10, 9), '会话时长 = 首末消息差', `n=${r1.durationMs}`);
  const r3 = rows.find((r) => r.id === 's3');
  log(r3.totalTokens === 0 && r3.models.length === 0, '无 usage 会话兜底为 0', `${r3.totalTokens}/${r3.models.length}`);
  const byKw = filterRows(rows, { keyword: '重构' });
  log(byKw.length === 1 && byKw[0].id === 's1', '按标题关键词过滤明细', `n=${byKw.length}`);
  const byWs = filterRows(rows, { workspaceId: 'C:/proj/b' });
  log(byWs.length === 1 && byWs[0].id === 's2', '按工作区过滤明细', `n=${byWs.length}`);
  const p1 = paginate(rows, 1, 2);
  log(p1.total === 4 && p1.pages === 2 && p1.rows.length === 2, '分页第 1 页', JSON.stringify({ t: p1.total, p: p1.pages }));
  const p9 = paginate(rows, 9, 2);
  log(p9.page === 2, '越界页收敛到最后一页', `page=${p9.page}`);
  const p0 = paginate([], 1, 10);
  log(p0.total === 0 && p0.rows.length === 0 && p0.pages === 1, '空结果分页', JSON.stringify(p0));
}

console.log('\n[5b] 工作区下拉选项');
{
  const sessions = [
    { id: 'x1', workspaceId: 'C:\\proj\\src', title: 'a', mode: '', createdAt: at(19, 9), updatedAt: at(19, 9), messages: [uMsg(at(19, 9), 'a')] },
    { id: 'x2', workspaceId: 'C:\\proj\\src', title: 'b', mode: '', createdAt: at(19, 9), updatedAt: at(19, 9), messages: [uMsg(at(19, 9), 'b')] },
    // 与 x1 同名目录（最后一段都是 src）：下拉里必须能区分，否则用户根本选不对
    { id: 'x3', workspaceId: 'D:\\other\\src', title: 'c', mode: '', createdAt: at(19, 9), updatedAt: at(19, 9), messages: [uMsg(at(19, 9), 'c')] },
    { id: 'x4', workspaceId: 'C:\\proj\\beta', title: 'd', mode: '', createdAt: at(19, 9), updatedAt: at(19, 9), messages: [uMsg(at(19, 9), 'd')] },
    // 20 天前的旧会话：只应计入 all，不该计入 7d
    { id: 'x6', workspaceId: 'C:\\proj\\beta', title: 'f', mode: '', createdAt: at(1, 9), updatedAt: at(1, 9), messages: [uMsg(at(1, 9), 'f')] },
    { id: 'x5', workspaceId: '', title: 'e', mode: '', createdAt: at(19, 9), updatedAt: at(19, 9), messages: [uMsg(at(19, 9), 'e')] },
  ];
  const opts = workspaceOptions(sessions);
  const brief = opts.map((o) => `${o.label}:${o.sessions}`).join(' | ');
  log(opts.length === 4, '按工作区分组（含未归属）', brief);
  log(opts[0].id === 'C:\\proj\\src' && opts[0].sessions === 2, '按会话数倒序', JSON.stringify(opts[0]));
  log(
    opts[opts.length - 1].id === NO_WORKSPACE_ID && opts[opts.length - 1].sessions === 1,
    '未归属固定排最后',
    JSON.stringify(opts[opts.length - 1]),
  );
  const labels = opts.filter((o) => o.id !== NO_WORKSPACE_ID).map((o) => o.label);
  log(new Set(labels).size === labels.length, '同名目录已消歧', labels.join(' | '));
  log(labels.includes('proj/src') && labels.includes('other/src'), '消歧方式为补父级目录', labels.join(' | '));
  log(opts.find((o) => o.id === 'C:\\proj\\beta').label === 'beta', '不重名的仍用短名', brief);

  // 计数必须跟着当前范围收窄，否则会出现「标着 2 条、选进去只有 1 条」
  const opts7 = workspaceOptions(filterSessions(sessions, { range: '7d' }, NOW));
  log(opts7.find((o) => o.id === 'C:\\proj\\beta').sessions === 1, '7d 下计数只剩范围内的会话', JSON.stringify(opts7.find((o) => o.id === 'C:\\proj\\beta')));
  log(opts7.length === 4, '范围收窄不丢工作区选项', JSON.stringify(opts7.map((o) => o.label)));
  log(workspaceOptions([]).length === 0, '空集合返回空选项', '');
}

console.log('\n[6] 回归 / 移动平均 / 预测 / 异常');
{
  const inc = [100, 200, 300, 400, 500];
  const r = linearRegression(inc);
  log(Math.abs(r.slope - 100) < 1e-6, '完美线性斜率 = 100', `slope=${r.slope}`);
  log(Math.abs(r.intercept - 100) < 1e-6, '截距 = 100', `intercept=${r.intercept}`);
  log(Math.abs(r.r2 - 1) < 1e-6, 'R² = 1', `r2=${r.r2}`);
  const dec = linearRegression([500, 400, 300, 200, 100]);
  log(dec.slope < 0, '下降序列斜率为负', `slope=${dec.slope}`);
  log(linearRegression([7]).slope === 0 && linearRegression([]).r2 === 0, '样本不足不炸', '');

  const ma = movingAverage([10, 20, 30, 40], 2);
  log(ma[0] === 10 && ma[1] === 15 && ma[3] === 35, '移动平均窗口 2', ma.join(','));
  log(tailAverage([1, 2, 3, 100, 100], 2) === 100, '尾部均值取近 2 天', `${tailAverage([1, 2, 3, 100, 100], 2)}`);

  // 预测用独立构造的日序列：20 天且每天都活着（真实场景里至少要有几天数据才谈得上预测）
  const dayPoint = (date, totalTokens) => ({
    date, sessions: 1, messages: 4, userMessages: 2, assistantMessages: 2,
    toolCalls: 2, toolFailures: 0, promptTokens: totalTokens, completionTokens: 0, totalTokens,
  });
  const daily = Array.from({ length: 20 }, (_, i) =>
    dayPoint(toDayKey(NOW - (19 - i) * 86400000), 10000 + i * 500),
  );
  const fc = forecastSeries(daily, { horizon: 7 });
  log(fc.length === 7, '预测 7 天', `n=${fc.length}`);
  log(fc.every((p) => p.tokens >= 0 && p.lower >= 0 && p.upper >= p.tokens), '预测非负且区间包含点值', JSON.stringify(fc[0]));
  log(fc[0].date > daily[daily.length - 1].date, '预测接在最后一天之后', `${fc[0].date}`);
  const width = (p) => p.upper - p.lower;
  log(width(fc[6]) >= width(fc[0]), '置信带随外推变宽', `${width(fc[0])} -> ${width(fc[6])}`);
  log(forecastSeries(daily, { horizon: 0 }).length === 0, 'horizon=0 返回空', '');

  // 有效样本不足时不硬凑预测/异常（否则一两天数据也会给出"看起来很确定"的直线）
  const sparse = Array.from({ length: 20 }, (_, i) => dayPoint(toDayKey(NOW - (19 - i) * 86400000), i === 18 ? 90000 : 0));
  log(forecastSeries(sparse, { horizon: 7 }).length === 0, '只有 1 天有数据时不给预测', '');
  log(detectAnomalies(sparse).length === 0, '只有 1 天有数据时不算异常', '');
  const twoDays = sparse.map((p, i) => ({ ...p, totalTokens: i >= 18 ? 90000 : 0 }));
  log(forecastSeries(twoDays, { horizon: 7 }).length === 0, '2 天有数据仍不给预测', '');
  log(detectAnomalies(twoDays).length === 0, '2 天有数据仍不算异常', '');

  const flat = Array.from({ length: 6 }, (_, i) => ({ date: `2026-10-0${i + 1}`, sessions: 0, messages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolFailures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 100 }));
  log(detectAnomalies(flat).length === 0, '恒定序列无异常', '');
  const spiky = flat.map((p, i) => ({ ...p, totalTokens: i === 3 ? 100000 : 100 }));
  const anom = detectAnomalies(spiky);
  log(anom.length === 1 && anom[0].date === '2026-10-04' && anom[0].z > 2, '尖锐峰值被识别为异常', JSON.stringify(anom));
}

console.log('\n[7] 圆环指标与洞察');
{
  const sessions = filterSessions(makeSessions(), { range: 'all' }, NOW);
  const daily = collectDaily(sessions, { range: 'all', now: NOW });
  const summary = summarize(sessions, daily);
  const kpis = buildKpis(summary, daily);
  log(kpis.length === 4, '4 个圆环指标', kpis.map((k) => k.key).join(','));
  log(kpis.every((k) => k.value >= 0 && k.value <= 100), '取值 0-100', kpis.map((k) => k.value).join(','));
  log(kpis.every((k) => typeof k.display === 'string' && k.display.length > 0), '均有展示文案', '');
  const tool = kpis.find((k) => k.key === 'tool');
  log(Math.abs(tool.value - 60) < 0.01, '工具成功率 = 100-40', `value=${tool.value}`);

  const score = activityScore(summary, daily);
  log(score >= 0 && score <= 100, '活跃度评分 0-100', `score=${score}`);

  const models = modelDistribution(sessions);
  const tools = toolDistribution(sessions);
  const hourly = hourlyActivity(sessions);

  const trend = buildTrend(daily);
  log(['up', 'down', 'flat'].includes(trend.direction), '趋势方向合法', trend.direction);
  log(typeof trend.r2 === 'number' && trend.r2 >= 0 && trend.r2 <= 1, 'R² 在 0-1', `r2=${trend.r2}`);
  // 这份 fixture 近 14 天只有 2 天有记录：按设计不出预测（硬凑出来的直线会假装很确定）
  log(trend.forecast.length === 0, '近 14 天样本太稀时不给预测', `n=${trend.forecast.length}`);

  const insights = buildInsights({ summary, daily, trend, models, tools, hourly });
  log(insights.length >= 4, '洞察条数 >= 4', `n=${insights.length}`);
  log(insights.every((i) => ['good', 'warn', 'info'].includes(i.level) && i.title && i.detail), '洞察字段完整', '');
  log(insights.some((i) => i.title.includes('工具失败率偏高')), '失败率 40% 触发告警', '');

  // 数据充足时：趋势必须给出 7 天预测，且洞察里要有对应的结论
  const dense = Array.from({ length: 20 }, (_, i) => ({
    ...daily[0],
    date: toDayKey(NOW - (19 - i) * 86400000),
    sessions: 1, messages: 4, userMessages: 2, assistantMessages: 2,
    toolCalls: 2, toolFailures: 0,
    promptTokens: 5000 + i * 300, completionTokens: 0, totalTokens: 5000 + i * 300,
  }));
  const denseTrend = buildTrend(dense);
  log(denseTrend.forecast.length === 7, '趋势含 7 天预测', `n=${denseTrend.forecast.length}`);
  const denseInsights = buildInsights({ summary, daily: dense, trend: denseTrend, models, tools, hourly });
  log(
    denseInsights.some((i) => i.title.includes('未来 7 天')),
    '含预测结论',
    denseInsights.map((i) => i.title).join(' | ').slice(0, 120),
  );
  log(buildInsights({ summary: summarize([], []), daily: [], trend: buildTrend([]), models: [], tools: [], hourly: new Array(24).fill(0) })
    .some((i) => i.title.includes('暂无历史数据')), '空数据给出空态洞察', '');
}

console.log('\n[8] buildDashboard 端到端');
{
  const d = buildDashboard(makeSessions(), { range: '30d' }, NOW);
  log(d.range === '30d' && d.generatedAt === NOW, '返回元信息', `${d.range}/${d.generatedAt}`);
  log(d.daily.length === 30, '30d 视图 30 个点', `n=${d.daily.length}`);
  log(d.summary.sessions === 3, '30d 命中 3 个会话（排除 8 月）', `n=${d.summary.sessions}`);
  log(d.kpis.length === 4 && d.models.length === 2 && d.tools.length >= 3, '看板各区块齐全', `${d.kpis.length}/${d.models.length}/${d.tools.length}`);
  log(
    d.insights.length > 0 && d.trend.forecast.length === 0,
    '样本稀疏：仍出洞察但不出预测',
    `ins=${d.insights.length}/fc=${d.trend.forecast.length}`,
  );
  log(d.hourly.length === 24, '24 小时热力', `n=${d.hourly.length}`);
  const all = buildDashboard(makeSessions(), { range: 'all' }, NOW);
  log(all.summary.sessions === 4, 'all 命中 4 个会话', `n=${all.summary.sessions}`);
  const kw = buildDashboard(makeSessions(), { range: 'all', keyword: '可视化' }, NOW);
  log(kw.summary.sessions === 1, '看板支持关键词筛选', `n=${kw.summary.sessions}`);

  // 连续 10 天有记录时，看板应当给出 7 天预测（回归 + 置信带）
  const denseSessions = Array.from({ length: 10 }, (_, i) => ({
    id: `dense${i}`, title: `连续第 ${i + 1} 天`, workspaceId: 'C:/proj/a', mode: 'craft',
    createdAt: at(10 + i, 9), updatedAt: at(10 + i, 10),
    messages: [
      uMsg(at(10 + i, 9), '继续'),
      aMsg(at(10 + i, 9, 1), { prompt_tokens: 1000 + i * 100, completion_tokens: 200, total_tokens: 1200 + i * 100, model: 'glm-4.6' }, []),
    ],
  }));
  const denseDash = buildDashboard(denseSessions, { range: '30d' }, NOW);
  log(denseDash.trend.forecast.length === 7, '数据充足时看板给出 7 天预测', `n=${denseDash.trend.forecast.length}`);
  log(denseDash.trend.anomalies.length >= 0, '异常检测结果始终是数组', `n=${denseDash.trend.anomalies.length}`);
  log(formatCompact(9700) === '9.7k' && formatCompact(1200000) === '1.2M' && formatCompact(42) === '42', '紧凑数字格式', formatCompact(9700));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
