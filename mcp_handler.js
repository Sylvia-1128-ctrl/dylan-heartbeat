/**
 * MCP 查岗模块 - Dylan Heartbeat
 * 
 * 提供 JSON-RPC 2.0 端点 /v1/mcp，让 Kelivo 等 MCP 客户端
 * 可以在聊天中调用工具查询用户手机状态、发送推送。
 * 
 * 使用方式：在 server.js 的 app.listen 之前添加：
 *   require("./mcp_handler").register(app);
 */

const fs = require("fs-extra");
const path = require("path");

const DEVICE_STATUS_FILE = path.join(__dirname, "device_status.json");
const ACTIVITY_LOG_FILE = path.join(__dirname, "activity_log.jsonl");
const MAX_LOG_LINES = 500;
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";

// ========================
// 活动日志
// ========================

function appendActivityLog(entry) {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(ACTIVITY_LOG_FILE, line);
    trimLogIfNeeded();
  } catch (e) {
    console.log("活动日志写入失败:", e.message);
  }
}

function trimLogIfNeeded() {
  try {
    if (!fs.existsSync(ACTIVITY_LOG_FILE)) return;
    const content = fs.readFileSync(ACTIVITY_LOG_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(-MAX_LOG_LINES);
      fs.writeFileSync(ACTIVITY_LOG_FILE, trimmed.join("\n") + "\n");
    }
  } catch (e) {
    console.log("活动日志裁剪失败:", e.message);
  }
}

function readActivityLog() {
  try {
    if (!fs.existsSync(ACTIVITY_LOG_FILE)) return [];
    const content = fs.readFileSync(ACTIVITY_LOG_FILE, "utf-8");
    return content.trim().split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function calculateAppSessions(log) {
  const sessions = {};
  let lastApp = null;
  let lastTime = null;

  for (const entry of log) {
    if (entry.app && entry.app !== lastApp) {
      if (lastApp && lastTime) {
        const duration = Math.floor((new Date(entry.time) - new Date(lastTime)) / 1000);
        if (duration > 0 && duration < 7200) {
          sessions[lastApp] = (sessions[lastApp] || 0) + duration;
        }
      }
      lastApp = entry.app;
      lastTime = entry.time;
    }
  }
  return sessions;
}

// ========================
// 文件监听（自动记录活动）
// ========================

let lastStatusContent = "";

function startWatching() {
  if (!fs.existsSync(DEVICE_STATUS_FILE)) {
    // 文件还不存在，等创建后再监听
    setTimeout(startWatching, 5000);
    return;
  }

  try {
    // 用 watchFile 替代 watch，更可靠（尤其在容器环境）
    fs.watchFile(DEVICE_STATUS_FILE, { interval: 2000 }, () => {
      try {
        const content = fs.readFileSync(DEVICE_STATUS_FILE, "utf-8");
        if (content === lastStatusContent) return;
        lastStatusContent = content;

        const status = JSON.parse(content);
        if (!status || !status.receivedAt) return;

        appendActivityLog({
          app: status.currentApp || null,
          battery: status.battery ?? null,
          focusMode: status.focusMode || null,
          time: status.receivedAt
        });
        console.log(`📊 活动已记录: ${status.currentApp || "未知"} (${status.battery}%)`);
      } catch (e) {
        // 文件正在写入时可能读取失败，忽略
      }
    });
    console.log("📊 MCP: 活动监听已启动");
  } catch (e) {
    console.log("活动监听启动失败:", e.message);
    setTimeout(startWatching, 5000);
  }
}

// ========================
// MCP 工具定义
// ========================

const TOOLS = [
  {
    name: "check_activity",
    description: "查看用户最近的手机活动：最近打开了哪些App、各App使用时长、当前状态",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "返回最近几条记录，默认10" }
      }
    }
  },
  {
    name: "send_bark",
    description: "给用户手机发送一条推送通知弹窗",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "推送标题，默认为'小忱'" },
        content: { type: "string", description: "推送正文内容" }
      },
      required: ["content"]
    }
  },
  {
    name: "get_device_status",
    description: "获取用户手机当前状态：电量、当前App、专注模式、天气等",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// ========================
// 工具实现
// ========================

function checkActivity(args = {}) {
  const limit = args.limit || 10;
  const log = readActivityLog();
  const recent = log.slice(-limit).reverse();
  const sessions = calculateAppSessions(log);

  // 同时读取当前状态
  let currentStatus = null;
  try {
    if (fs.existsSync(DEVICE_STATUS_FILE)) {
      currentStatus = fs.readJsonSync(DEVICE_STATUS_FILE);
    }
  } catch {}

  const lines = [];

  if (currentStatus && currentStatus.currentApp) {
    const time = new Date(currentStatus.receivedAt).toLocaleString("zh-CN", { timeZone: TIME_ZONE });
    lines.push(`【当前状态】`);
    lines.push(`  正在使用: ${currentStatus.currentApp}`);
    if (currentStatus.battery != null) lines.push(`  电量: ${currentStatus.battery}%`);
    if (currentStatus.focusMode) lines.push(`  专注模式: ${currentStatus.focusMode}`);
    lines.push(`  更新时间: ${time}`);
  }

  if (recent.length > 0) {
    lines.push(`\n【最近${Math.min(limit, recent.length)}条活动】`);
    for (const entry of recent) {
      const time = new Date(entry.time).toLocaleString("zh-CN", { timeZone: TIME_ZONE });
      const batteryStr = entry.battery != null ? ` [${entry.battery}%]` : "";
      lines.push(`  ${time} - ${entry.app || "未知"}${batteryStr}`);
    }
  } else {
    lines.push("\n暂无活动记录");
  }

  if (Object.keys(sessions).length > 0) {
    lines.push("\n【App 使用时长估算】");
    const sorted = Object.entries(sessions).sort((a, b) => b[1] - a[1]);
    for (const [app, secs] of sorted) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      lines.push(`  ${app}: ${m}分${s}秒`);
    }
  }

  return lines.join("\n") || "暂无数据";
}

async function sendBark(args = {}) {
  const barkKey = process.env.BARK_KEY;
  if (!barkKey) return "Bark Key 未配置，无法推送";

  const title = args.title || "小忱";
  const content = args.content;
  if (!content) return "推送内容不能为空";

  const iconUrl = process.env.CUSTOM_ICON_URL || "";

  try {
    const payload = {
      title,
      body: content,
      device_key: barkKey
    };
    if (iconUrl) payload.icon = iconUrl;

    const response = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      return `推送成功：${title} | ${content}`;
    } else {
      const text = await response.text();
      return `推送失败 (HTTP ${response.status}): ${text.slice(0, 100)}`;
    }
  } catch (e) {
    return `推送异常：${e.message}`;
  }
}

function getDeviceStatus() {
  try {
    if (!fs.existsSync(DEVICE_STATUS_FILE)) return "暂无设备状态数据";
    const status = fs.readJsonSync(DEVICE_STATUS_FILE);
    const lines = ["【当前设备状态】"];
    if (status.battery != null) lines.push(`  电量: ${status.battery}%`);
    if (status.currentApp) lines.push(`  当前App: ${status.currentApp}`);
    if (status.focusMode) lines.push(`  专注模式: ${status.focusMode}`);
    if (status.weather) lines.push(`  天气: ${status.weather}`);
    if (status.reminders) lines.push(`  提醒: ${status.reminders}`);
    if (status.receivedAt) {
      const time = new Date(status.receivedAt).toLocaleString("zh-CN", { timeZone: TIME_ZONE });
      lines.push(`  上报时间: ${time}`);
    }
    return lines.join("\n");
  } catch (e) {
    return `读取状态失败: ${e.message}`;
  }
}

const FUNCS = {
  check_activity: checkActivity,
  send_bark: sendBark,
  get_device_status: getDeviceStatus
};

// ========================
// 注册路由
// ========================

function register(app) {
  // 注册 MCP JSON-RPC 端点
  app.post("/v1/mcp", async (req, reply) => {
    const body = req.body || {};
    const method = body.method;
    const params = body.params || {};
    const rid = body.id;

    // initialize
    if (method === "initialize") {
      return reply.send({
        jsonrpc: "2.0",
        id: rid,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dylan-heartbeat", version: "1.0" }
        }
      });
    }

    // tools/list
    if (method === "tools/list") {
      return reply.send({
        jsonrpc: "2.0",
        id: rid,
        result: { tools: TOOLS }
      });
    }

    // tools/call
    if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};

      if (!FUNCS[name]) {
        return reply.send({
          jsonrpc: "2.0",
          id: rid,
          error: { code: -32601, message: `未知工具: ${name}` }
        });
      }

      try {
        let result = FUNCS[name](args);
        if (result && typeof result.then === "function") {
          result = await result;
        }
        return reply.send({
          jsonrpc: "2.0",
          id: rid,
          result: { content: [{ type: "text", text: String(result) }] }
        });
      } catch (e) {
        return reply.send({
          jsonrpc: "2.0",
          id: rid,
          error: { code: -32603, message: e.message }
        });
      }
    }

    // unknown method
    return reply.send({
      jsonrpc: "2.0",
      id: rid,
      error: { code: -32601, message: `未知方法: ${method}` }
    });
  });

  // 启动活动监听
  startWatching();

  console.log("✅ MCP 查岗端点已注册: /v1/mcp");
}

module.exports = { register, appendActivityLog, readActivityLog };
