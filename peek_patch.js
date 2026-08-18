/**
 * peek_patch.js - 在 server.js 启动后注入偷看模块
 * 
 * 使用方式：在 package.json 的 start 脚本里：
 *   "start": "node -r ./peek_patch.js server.js & node wake_up.js & wait"
 * 
 * 或者直接在 server.js 末尾加一行：
 *   try { require('./peek_handler').register(app); } catch(e) { console.log('Peek:', e.message); }
 * 
 * 这个文件提供第三种方式：通过 require hook 自动注入。
 * 但最简单的方式是直接改 server.js 末尾的启动区域。
 * 
 * === 推荐方式 ===
 * 在 server.js 的 "// MCP 查岗" 那行附近加：
 * 
 *   // 偷看模块
 *   try { require('./peek_handler').register(app); } catch(e) { console.log('Peek:', e.message); }
 * 
 * 同时在 app.register 区域加：
 *   app.register(require('@fastify/multipart'), { limits: { fileSize: 10 * 1024 * 1024 } });
 */

console.log('peek_patch.js: 请参照此文件顶部注释，在 server.js 中添加两行代码。');
