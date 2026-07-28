const fs = require('node:fs').promises;
const path = require('node:path');
const Database = require('./database');
const { createApp } = require('./app');

require('dotenv').config();

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const rootDir = __dirname;
const db = new Database();

async function start() {
  await db.init();
  await Promise.all([
    fs.mkdir(path.join(rootDir, 'sites'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'uploads'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'database', 'assets', 'branding'), { recursive: true })
  ]);

  const app = createApp({ db, rootDir });
  const server = app.listen(PORT, '0.0.0.0', () => {
    const admin = db.getUserByUsername(process.env.ADMIN_USERNAME || 'admin');
    console.log(`🚀 作品首页: http://localhost:${PORT}`);
    console.log(`🔐 登录页面: http://localhost:${PORT}/login`);
    console.log(`📊 管理后台: http://localhost:${PORT}/admin/`);
    if (admin?.default_password) console.warn('⚠️  当前管理员仍使用不安全的初始密码，请立即在账号设置中修改！');
  });

  process.on('SIGTERM', () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

start().catch((error) => {
  console.error('启动失败:', error);
  db.close();
  process.exit(1);
});
