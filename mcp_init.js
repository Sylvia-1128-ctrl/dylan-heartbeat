/**
 * mcp_init.js - MCP 启动注入器
 *
 * 替代直接运行 server.js。
 * 在 server.js 的 Fastify 实例调用 listen() 之前，
 * 自动把 mcp_handler 里的路由注册进去。
 *
 * 原理：
 *   1. 先 require('fastify') 拿到原始工厂函数并缓存
 *   2. 替换模块缓存里的 fastify 为一个包装版
 *   3. 包装版在创建实例后，把 listen() 方法再包一层
 *   4. server.js require('fastify') 拿到的就是我们的包装版
 *   5. 当 server.js 调用 app.listen() 时，先注册 MCP 路由再真正监听
 */

const mcpHandler = require('./mcp_handler');

// 1. 先加载真正的 fastify 并保存
const fastifyPath = require.resolve('fastify');
const originalFastify = require(fastifyPath);

// 2. 替换模块缓存
require.cache[fastifyPath] = Object.assign(
  Object.create(null),
  require.cache[fastifyPath],
  {
    exports: function patchedFastify(...args) {
      const app = originalFastify(...args);

      // 3. 包装 listen()
      const originalListen = app.listen.bind(app);
      app.listen = function (...listenArgs) {
        try {
          mcpHandler.register(app);
        } catch (e) {
          console.error('MCP 注册失败（不影响主服务启动）:', e.message);
        }
        return originalListen(...listenArgs);
      };

      return app;
    }
  }
);

// 4. 加载 server.js，它会用上面的包装版 fastify
require('./server');
