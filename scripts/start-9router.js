import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();

console.log('\n╭── 🌐 9ROUTER LOCAL GATEWAY LAUNCHER ───────────────────────────────────────╮');
console.log('│  Cấu hình 9Router Gateway với 3-Tier Auto-Fallback Pool                    │');
console.log('╰────────────────────────────────────────────────────────────────────────────╯\n');

const env = { ...process.env };
const configFile = path.resolve('9router.config.json');

console.log('🔑 Nạp API Keys từ .env:');
console.log(' - GEMINI_API_KEY:    ', env.GEMINI_API_KEY ? '✔ Đã nạp' : '✖ Trống');
console.log(' - GROQ_API_KEY:      ', env.GROQ_API_KEY ? '✔ Đã nạp' : '✖ Trống');
console.log(' - CEREBRAS_API_KEY:  ', env.CEREBRAS_API_KEY ? '✔ Đã nạp' : '✖ Trống');
console.log(' - SAMBANOVA_API_KEY: ', env.SAMBANOVA_API_KEY ? '✔ Đã nạp' : '✖ Trống');
console.log(' - OPENROUTER_API_KEY:', env.OPENROUTER_API_KEY ? '✔ Đã nạp' : '✖ Trống');
console.log(' - DEEPSEEK_API_KEY:  ', env.DEEPSEEK_API_KEY ? '✔ Đã nạp' : '✖ Trống');

console.log('\n🚀 Đang khởi động 9Router tại http://localhost:20128/v1 ...');

const child = spawn('npx', ['--yes', '9router', '--config', configFile], {
  env,
  shell: true,
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error('\n✖ Lỗi khi khởi động 9Router:', err.message);
  console.log('💡 Gợi ý: Bạn có thể cài đặt 9router toàn cục bằng: npm install -g 9router');
});

child.on('exit', (code) => {
  console.log(`\n9Router đã dừng (Exit code: ${code}).`);
});
