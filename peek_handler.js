/**
 * 偷看屏幕模块 - Dylan Heartbeat
 * 
 * 链路：
 *   1. MCP 调用 peek_screen 工具 → 服务器发邮件到 iCloud
 *   2. iPhone 快捷指令检测到邮件 → 自动截屏
 *   3. 快捷指令 POST 截图(base64) 到 /v1/peek/upload
 *   4. MCP 调用 get_screenshot 查看最近截图
 * 
 * 环境变量（Railway 里配置）：
 *   SMTP_HOST       - SMTP 服务器（如 smtp.qq.com）
 *   SMTP_PORT       - 端口（默认 465）
 *   SMTP_USER       - 发件邮箱
 *   SMTP_PASS       - 应用专用密码
 *   PEEK_RECIPIENT  - 收件邮箱（iCloud）
 *   PEEK_SECRET     - 上传接口密钥（防止别人调用）
 */

const fs = require("fs-extra");
const path = require("path");
const nodemailer = require("nodemailer");

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const MAX_SCREENSHOTS = 20;

fs.ensureDirSync(SCREENSHOTS_DIR);

// ========================
// SMTP 发件
// ========================

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "465");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendPeekEmail() {
  const transport = createTransport();
  if (!transport) return "SMTP 未配置，无法发送触发邮件";
  const recipient = process.env.PEEK_RECIPIENT;
  if (!recipient) return "收件邮箱 PEEK_RECIPIENT 未配置";
  const timestamp = new Date().toISOString();
  try {
    await transport.sendMail({
      from: process.env.SMTP_USER,
      to: recipient,
      subject: `peek ${timestamp}`,
      text: `peek request at ${timestamp}`
    });
    return `触发邮件已发送至 ${recipient}，等待截图上传...`;
  } catch (e) {
    return `发送邮件失败: ${e.message}`;
  }
}

// ========================
// 截图管理
// ========================

function getScreenshots() {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return [];
    return fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(SCREENSHOTS_DIR, f));
        return { name: f, time: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
}

function cleanupScreenshots() {
  const files = getScreenshots();
  if (files.length > MAX_SCREENSHOTS) {
    for (const f of files.slice(MAX_SCREENSHOTS)) {
      try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, f.name)); } catch {}
    }
  }
}

// ========================
// MCP 工具定义
// ========================

const PEEK_TOOLS = [
  {
    name: "peek_screen",
    description: "触发远程截屏：发送邮件到用户 iPhone，快捷指令会自动截屏并上传。延迟约10秒到1分钟。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_screenshot",
    description: "获取最近的截图信息。返回截图文件名、时间和访问URL。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "返回最近几张，默认1" }
      }
    }
  }
];

// ========================
// 工具实现
// ========================

async function peekScreen() {
  return await sendPeekEmail();
}

function getScreenshot(args = {}) {
  const limit = args.limit || 1;
  const files = getScreenshots().slice(0, limit);
  if (files.length === 0) return "暂无截图。可能还没有触发过截屏，或者截图还没上传。";

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.GATEWAY_BASE_URL || `http://localhost:${process.env.PORT || 3000}`);

  const lines = [`【最近${files.length}张截图】`];
  for (const f of files) {
    const time = new Date(f.time).toLocaleString("zh-CN", {
      timeZone: process.env.TIME_ZONE || "Asia/Shanghai"
    });
    const sizeKB = (f.size / 1024).toFixed(0);
    lines.push(`  ${time} | ${sizeKB}KB | ${baseUrl}/v1/peek/image/${f.name}`);
  }
  return lines.join("\n");
}

const PEEK_FUNCS = {
  peek_screen: peekScreen,
  get_screenshot: getScreenshot
};

// ========================
// 鉴权辅助
// ========================

function verifyPeekAuth(req) {
  // 支持多种方式验证：
  // 1. x-peek-secret 头部 = PEEK_SECRET
  // 2. body.secret = PEEK_SECRET
  // 3. x-api-key 头部 = GATEWAY_API_KEY（和状态上报用同一个key）
  const peekSecret = process.env.PEEK_SECRET;
  const gatewayKey = process.env.GATEWAY_API_KEY;
  const body = req.body || {};

  const fromHeader = req.headers["x-peek-secret"] || "";
  const fromBody = body.secret || "";
  const fromApiKey = req.headers["x-api-key"] || "";

  // 如果提供了 gateway key 且匹配，直接通过
  if (gatewayKey && fromApiKey === gatewayKey) return true;

  // 如果提供了 peek secret 且匹配
  if (peekSecret && (fromHeader === peekSecret || fromBody === peekSecret)) return true;

  // 如果 PEEK_SECRET 没配置，只要 gateway key 匹配就行
  if (!peekSecret && gatewayKey && fromApiKey === gatewayKey) return true;

  return false;
}

// ========================
// 注册 HTTP 路由（由 mcp_handler 调用）
// ========================

function registerRoutes(app) {
  // 截图上传接口（快捷指令用 base64 JSON 方式上传）
  app.post("/v1/peek/upload", async (req, reply) => {
    if (!verifyPeekAuth(req)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const body = req.body || {};
      const { image, filename: rawFilename } = body;
      if (!image) {
        return reply.code(400).send({ error: "Missing 'image' field (base64 encoded)" });
      }

      const timestamp = Date.now();
      const ext = rawFilename ? path.extname(rawFilename) : ".png";
      const filename = `peek_${timestamp}${ext}`;
      const filepath = path.join(SCREENSHOTS_DIR, filename);

      const buffer = Buffer.from(image, "base64");
      fs.writeFileSync(filepath, buffer);
      cleanupScreenshots();

      console.log(`📸 截图已接收: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);

      return reply.send({
        success: true,
        filename,
        size: buffer.length,
        time: new Date(timestamp).toISOString()
      });
    } catch (e) {
      console.log("截图上传失败:", e.message);
      return reply.code(500).send({ error: e.message });
    }
  });

  // 截图查看接口
  app.get("/v1/peek/image/:filename", async (req, reply) => {
    const secret = process.env.PEEK_SECRET || "";
    const gatewayKey = process.env.GATEWAY_API_KEY || "";
    const provided = req.headers["x-peek-secret"] || req.headers["x-api-key"] || (req.query && req.query.secret) || "";

    if (!((secret && provided === secret) || (gatewayKey && provided === gatewayKey))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const filename = req.params.filename;
    if (filename.includes("..") || filename.includes("/")) {
      return reply.code(400).send({ error: "Invalid filename" });
    }

    const filepath = path.join(SCREENSHOTS_DIR, filename);
    if (!fs.existsSync(filepath)) {
      return reply.code(404).send({ error: "Not found" });
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    return reply.header("Content-Type", mimeMap[ext] || "application/octet-stream").send(fs.readFileSync(filepath));
  });

  // 最新截图快捷接口
  app.get("/v1/peek/latest", async (req, reply) => {
    const secret = process.env.PEEK_SECRET || "";
    const gatewayKey = process.env.GATEWAY_API_KEY || "";
    const provided = req.headers["x-peek-secret"] || req.headers["x-api-key"] || (req.query && req.query.secret) || "";

    if (!((secret && provided === secret) || (gatewayKey && provided === gatewayKey))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const files = getScreenshots();
    if (files.length === 0) {
      return reply.code(404).send({ error: "No screenshots" });
    }

    const latest = files[0];
    const filepath = path.join(SCREENSHOTS_DIR, latest.name);
    const ext = path.extname(latest.name).toLowerCase();
    const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    return reply.header("Content-Type", mimeMap[ext] || "application/octet-stream").send(fs.readFileSync(filepath));
  });

  console.log("📸 偷看模块路由已注册: /v1/peek/*");
}

module.exports = { registerRoutes, PEEK_TOOLS, PEEK_FUNCS };
