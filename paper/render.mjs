import { chromium } from '/Users/zp/Documents/deepseek-harness/default-workspace/tools/browser/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';

const CHROME = '/Users/zp/.agent-browser/browsers/chrome-152.0.7977.64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
mkdirSync(`${ROOT}/build`, { recursive: true });

const langs = process.argv.slice(2);
const targets = langs.length > 0 ? langs : ['en', 'zh'];

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--font-render-hinting=none'],
});

const header = (title) => `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:6.8px;color:#666;padding:0 16mm;display:flex;justify-content:space-between;align-items:flex-end;">
<span style="letter-spacing:.08em;text-transform:uppercase;">${title}</span><span></span></div>`;
const footer = `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:6.8px;color:#666;padding:0 16mm;display:flex;justify-content:space-between;">
<span>Preprint · not peer reviewed · CC BY 4.0</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

for (const lang of targets) {
  const page = await browser.newPage();
  const title = lang === 'zh' ? 'Deep Connect · 账号绑定·端到端加密的多设备同步' : 'Deep Connect · account-bound multi-device synchronisation';
  await page.goto(`file://${ROOT}/build/paper-${lang}.html`, { waitUntil: 'load', timeout: 120000 });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  const out = `${ROOT}/build/DeepConnect-Nature-${lang.toUpperCase()}.pdf`;
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: header(title),
    footerTemplate: footer,
    margin: { top: '20mm', bottom: '16mm', left: '16mm', right: '16mm' },
    preferCSSPageSize: false,
  });
  console.log(`wrote ${out}`);
  await page.close();
}

await browser.close();
