/**
 * mcp_init.js - MCP 启动注入器
 *
 * 替代直接运行 server.js。
 * 通过 Module._load 拦截 Fastify 加载，
 * 在 server.js 的 Fastify 实例调用 listen() 之前，
 * 自动把 mcp_handler 里的路由注册进去。
 */

const Module = require('module');
const mcpHandler = require('./mcp_handler');
const originalLoad = Module._load;
let fastifyPatched = false;

Module._load = function(request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);

  if (request === 'fastify' && typeof result === 'function' && !fastifyPatched) {
    fastifyPatched = true;
    const originalFactory = result;

    const patched = function(...args) {
      const instance = originalFactory(...args);
      const originalListen = instance.listen.bind(instance);

      instance.listen = function(...listenArgs) {
        try {
          mcpHandler.register(instance);
          console.log('\u2705 MCP \u67e5\u5c97\u7aef\u70b9\u5df2\u6ce8\u518c (via mcp_init)');
        } catch(e) {
          console.error('MCP \u6ce8\u518c\u5931\u8d25\uff08\u4e0d\u5f71\u54cd\u4e3b\u670d\u52a1\uff09:', e.message);
        }
        return originalListen(...listenArgs);
      };

      return instance;
    };

    // 复制原始 Fastify 上的静态属性
    Object.keys(originalFactory).forEach(key => {
      try { patched[key] = originalFactory[key]; } catch(e) {}
    });
    if (originalFactory.prototype) {
      patched.prototype = originalFactory.prototype;
    }

    return patched;
  }

  return result;
};

// 加载 server.js，它 require('fastify') 时会触发上面的拦截
require('./server');
