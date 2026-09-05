// 浏览器环境下的 mock 后端：让前端可脱离 Node 后端独立开发/预览 UI。
// 数据风格与 preview.html 保持一致，覆盖所有 IPC command。

function seed(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const LOCAL_DEVICE = "f454fb59-a1b2-4c3d-9e8f-1234567890ab";

const models = [
  { model: "deepseek-v4-pro", provider: "deepseek" },
  { model: "GLM-5.3", provider: "智谱 GLM" },
  { model: "qwen3.7-max", provider: "Qwen" },
  { model: "MiniMax-M3", provider: "MiniMax" },
  { model: "deepseek-v4-flash", provider: "deepseek" },
  { model: "GLM-5-Turbo", provider: "智谱 GLM" },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function genRecords(count: number) {
  const recs: any[] = [];
  for (let i = 0; i < count; i++) {
    const m = models[i % models.length];
    const input = Math.round(8000 + seed(i * 13) * 90000);
    const output = Math.round(300 + seed(i * 7) * 4000);
    const reasoning = seed(i * 5) > 0.4 ? Math.round(seed(i * 9) * 6000) : 0;
    const cacheRead = Math.round(input * (0.7 + seed(i * 3) * 0.28));
    const d = new Date(2026, 8, 4 - (i % 60), Math.floor(8 + seed(i) * 12), Math.floor(seed(i * 2) * 60));
    const source = ["zcode", "codex", "dsh"][i % 3];
    recs.push({
      id: `${LOCAL_DEVICE}:${source}:${i}`,
      deviceId: LOCAL_DEVICE,
      deviceName: "这台电脑",
      source,
      providerId: m.provider,
      modelId: m.model,
      variant: "max",
      taskType: i % 2 ? "coding" : "chat",
      sessionId: `sess_${i}`,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheCreationTokens: 0,
      cacheReadTokens: cacheRead,
      startedAt: d.getTime(),
      completedAt: d.getTime() + Math.round(seed(i) * 120000),
      status: seed(i * 11) > 0.9 ? "error" : "success",
    });
  }
  return recs;
}

const allRecords = genRecords(240);

function calcTotal(r: any, mode: string): number {
  if (mode === "compact") return r.inputTokens + r.outputTokens;
  return r.inputTokens + r.outputTokens + r.reasoningTokens;
}

const mock = {
  invoke(cmd: string, args: any = {}): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const mode = args.mode || "full";
        switch (cmd) {
          case "load_config":
            resolve({
              deviceName: "这台电脑",
              webdav: { endpoint: "https://dav.example.com/dav", username: "admin", password: "********", root: "/dosage-sync", preset: "feiniu" },
              sources: [
                { source: "zcode", enabled: true, dataDir: "C:\\Users\\YOUR_NAME\\.zcode" },
                { source: "codex", enabled: false, dataDir: null },
                { source: "dsh", enabled: false, dataDir: null },
                // 【暂时隐藏 Antigravity 系】
                // { source: "antigravity", enabled: false, dataDir: null },
                // { source: "antigravity-ide", enabled: false, dataDir: null },
              ],
              schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true, notifyOnSuccess: false },
              totalMode: "full",
              theme: "light",
            });
            break;
          case "save_config": resolve({ ok: true, message: "设置保存成功" }); break;
          case "test_webdav": resolve({ ok: true, message: "连接正常" }); break;
          case "list_sources": resolve([
            { id: "zcode", name: "ZCode", enabled: true },
            { id: "codex", name: "Codex", enabled: false },
            { id: "dsh", name: "DeepSeek Harness", enabled: false },
            // 【暂时隐藏 Antigravity 系】
            // { id: "antigravity", name: "Antigravity", enabled: false },
            // { id: "antigravity-ide", name: "Antigravity IDE", enabled: false },
          ]); break;
          case "detect_source": {
            const mockDirs: Record<string, string> = {
              // 【暂时隐藏 Antigravity 系】
              // antigravity: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity",
              // "antigravity-ide": "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity IDE",
            };
            const path = mockDirs[args.source] || `C:\\Users\\YOUR_NAME\\.${args.source}`;
            resolve({ ok: true, path, deviceId: LOCAL_DEVICE });
            break;
          }
          case "health_source": resolve([
            { source: "zcode", name: "ZCode", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.zcode", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "codex", name: "Codex", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.codex", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "dsh", name: "DeepSeek Harness", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.dsh", readable: true, lastSyncAt: Date.now() - 60000 },
            // 【暂时隐藏 Antigravity 系】
            // { source: "antigravity", name: "Antigravity", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity", readable: true, lastSyncAt: Date.now() - 60000 },
            // { source: "antigravity-ide", name: "Antigravity IDE", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity IDE", readable: true, lastSyncAt: Date.now() - 60000 },
          ]); break;
          case "get_summary": {
            const localRecs = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source));
            const local = localRecs.reduce((s, r) => s + calcTotal(r, mode), 0);
            const remote = 0;
            const input = localRecs.reduce((s, r) => s + r.inputTokens, 0);
            const output = localRecs.reduce((s, r) => s + r.outputTokens, 0);
            const reasoning = localRecs.reduce((s, r) => s + r.reasoningTokens, 0);
            const cacheRead = localRecs.reduce((s, r) => s + r.cacheReadTokens, 0);
            const cacheCreate = localRecs.reduce((s, r) => s + r.cacheCreationTokens, 0);
            resolve({
              totalTokens: local + remote, todayTokens: Math.round((local + remote) * 0.011),
              localTokens: local, remoteTokens: remote, allTotalTokens: local + remote,
              cacheHitRate: cacheRead / (input || 1), todayCacheHitRate: cacheRead / (input || 1),
              cacheReadTokens: cacheRead, inputTokens: input,
              outputTokens: output, reasoningTokens: reasoning, cacheCreationTokens: cacheCreate,
              todayInputTokens: Math.round(input * 0.011), todayCacheReadTokens: Math.round(cacheRead * 0.011),
              recordCount: localRecs.length,
              todayRecordCount: Math.max(0, Math.round(localRecs.length * 0.011)),
              selectedDeviceId: args.deviceId || null,
            });
            break;
          }
          case "get_devices": {
            const local = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source)).reduce((s, r) => s + calcTotal(r, mode), 0);
            resolve([
              { deviceId: LOCAL_DEVICE, deviceName: "笔记本", source: "zcode,codex,dsh", lastSyncAt: Date.now() - 60000, online: true, totalTokens: local, isLocal: true },
            ]);
            break;
          }
          case "get_device_breakdowns": {
            const localRecs = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source));
            const sum = (key: string) => localRecs.reduce((n, r) => n + r[key], 0);
            resolve([{
              deviceId: LOCAL_DEVICE,
              deviceName: "笔记本",
              isLocal: true,
              totalTokens: Math.round(localRecs.reduce((n, r) => n + calcTotal(r, mode), 0)),
              inputTokens: sum("inputTokens"),
              outputTokens: sum("outputTokens"),
              reasoningTokens: sum("reasoningTokens"),
              cacheReadTokens: sum("cacheReadTokens"),
              cacheCreationTokens: sum("cacheCreationTokens"),
              recordCount: localRecs.length,
            }]);
            break;
          }
          case "get_trend": {
            const days = args.days || 30;
            const out: any[] = [];
            for (let i = days - 1; i >= 0; i--) {
              const d = new Date(2026, 8, 4); d.setDate(d.getDate() - i);
              const dow = d.getDay(); const weekend = dow === 0 || dow === 6 ? 0.55 : 1;
              const v = Math.round(4.6e6 * weekend * (0.72 + seed(i * 7 + days) * 0.56) * (0.65 + (days - i) / days * 0.35));
              out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, total: v, models: { "GPT-5": Math.round(v * 0.42), "Claude 4": Math.round(v * 0.33), "Gemini 2.5": Math.round(v * 0.25) } });
            }
            resolve(out);
            break;
          }
          case "get_heatmap": {
            const out: any[] = [];
            // 滚动一年窗口：按传入的 start/end 生成每日数据
            const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
            const endD = args.end ? parse(String(args.end)) : new Date(2026, 8, 4);
            const startD = args.start ? parse(String(args.start)) : new Date(endD.getFullYear(), endD.getMonth(), endD.getDate() - 364);
            const d = new Date(startD);
            while (d <= endD) {
              const h = seed(d.getMonth() * 31 + d.getDate());
              const v = Math.round(1500000 + h * 4.2e6);
              out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, total: v });
              d.setDate(d.getDate() + 1);
            }
            resolve(out);
            break;
          }
          case "get_aggregate": {
            const dim = args.dim || "model";
            const map: Record<string, any> = {};
            allRecords.filter((r) => !args.source || r.source === args.source).forEach((r) => {
              const key = dim === "provider" ? r.providerId : dim === "model" ? r.modelId : dim === "source" ? r.source : r.deviceName;
              if (!map[key]) map[key] = { key, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, count: 0 };
              map[key].inputTokens += r.inputTokens; map[key].outputTokens += r.outputTokens;
              map[key].reasoningTokens += r.reasoningTokens; map[key].cacheReadTokens += r.cacheReadTokens;
              map[key].cacheCreationTokens += r.cacheCreationTokens;
              map[key].totalTokens += calcTotal(r, mode); map[key].count++;
            });
            resolve(Object.values(map).sort((a: any, b: any) => b.totalTokens - a.totalTokens));
            break;
          }
          case "get_records": {
            const limit = args.limit || 50, offset = args.offset || 0;
            const filtered = allRecords.filter((r) =>
              (!args.source || r.source === args.source)
              && (!args.deviceId || r.deviceId === args.deviceId)
              && (!args.model || r.modelId === args.model)
              && (!args.provider || r.providerId === args.provider)
              && (!args.status || r.status === args.status)
            );
            resolve({ records: filtered.slice(offset, offset + limit), total: filtered.length });
            break;
          }
          case "start_sync": resolve(null); break;
          case "cancel_sync": resolve(null); break;
          case "get_sync_progress": resolve({ running: false, stage: "done", stageLabel: "同步完成", percent: 100, message: "最后同步 09:53" }); break;
          case "get_sync_logs": resolve([
            { id: 1, time: Date.now() - 60000, kind: "upload", level: "ok", message: "上传完成", detail: "本机新增 1,204 条记录，上传 3 个分片" },
            { id: 2, time: Date.now() - 70000, kind: "download", level: "ok", message: "拉取完成", detail: "拉取「公司笔记本」2 个分片，合并 886 条" },
            { id: 3, time: Date.now() - 75000, kind: "extract", level: "ok", message: "抽取完成", detail: "ZCode 增量抽取 1,204 条新记录" },
            { id: 4, time: Date.now() - 3600000, kind: "download", level: "error", message: "拉取失败", detail: "WebDAV 返回 401 · 账号密码错误" },
            { id: 5, time: Date.now() - 4000000, kind: "merge", level: "ok", message: "合并完成", detail: "按 deviceId:source:记录id 幂等合并" },
          ]); break;
          case "clear_sync_logs": resolve(null); break;
          case "export_data": {
            const ext = args.format === "json" ? "json" : "csv";
            resolve({ ok: true, path: `C:\\Users\\YOUR_NAME\\Downloads\\dosage-export.${ext}`, message: "导出成功" });
            break;
          }
          case "delete_device": resolve({ ok: true, message: "设备已删除（演示环境）" }); break;
          case "open_data_dir": resolve(null); break;
          case "get_data_dir": resolve("C:\\Users\\YOUR_NAME\\AppData\\Roaming\\DosageSync"); break;
          case "get_app_version": resolve("1.0.0"); break;
          case "get_is_portable": resolve(false); break;
          case "reset_local_cache": resolve({ ok: true, message: "本地缓存已清空（演示环境）" }); break;
          default: resolve(null);
        }
      }, 60);
    });
  },
};

export { mock, fmt };
