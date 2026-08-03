// 这个文件仅作为补丁说明，请手动将以下代码加入 server.js
// 位置：在 /v1/chat/completions 路由中，
// 找到 "const kelivoMessages = body.messages || [];" 这一行，
// 在它下方加入以下代码：
//
// // 记录用户最后活跃时间，供 wake_up.js 读取
// const hasUserMsg = kelivoMessages.some(m => m.role === "user");
// if (hasUserMsg) {
//   try {
//     fs.writeJsonSync("./last_active.json", { time: new Date().toISOString() });
//   } catch (e) { console.log("写入 last_active.json 失败:", e.message); }
// }
