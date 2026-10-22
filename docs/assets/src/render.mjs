// Renders the README images (light + dark) from HTML templates with real LexBG data.
//
//   cd docs/assets/src && npm i @fontsource/golos-text @fontsource/unbounded @fontsource/jetbrains-mono playwright-core
//   node render.mjs                       # writes ../*.png
//
// Data: amendments.json is exported from the weekly database (what_changed for ЗСч).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..');
const fontDir = process.env.FONT_DIR ?? path.join(here, 'node_modules', '@fontsource');
const amend = JSON.parse(fs.readFileSync(path.join(here, 'amendments.json'), 'utf8'));

// Fonts are embedded as data: URIs (a page loaded with setContent cannot read file:// URLs).
const face = (family, pkg, weight, subset) => {
  const b64 = fs.readFileSync(`${fontDir}/${pkg}/files/${pkg}-${subset}-${weight}-normal.woff2`).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
};
const fonts = ['cyrillic', 'latin'].flatMap(s => [
  ...[400, 500, 600, 700].map(w => face('Golos Text', 'golos-text', w, s)),
  ...[500, 600, 700].map(w => face('Unbounded', 'unbounded', w, s)),
  ...[400, 500].map(w => face('JetBrains Mono', 'jetbrains-mono', w, s)),
]).join('\n');

const THEMES = {
  light: { paper: '#F6F7F5', surface: '#FFFFFF', ink: '#16202B', muted: '#5B6672', line: '#DCE1DD', accent: '#0E7A5A', accentSoft: '#E2F1EA', amber: '#9A5A00', amberSoft: '#FBEFD8', red: '#B3261E', redSoft: '#FBE3E1' },
  dark: { paper: '#0E1418', surface: '#151D23', ink: '#E5EBE8', muted: '#97A3AB', line: '#26323A', accent: '#3DC593', accentSoft: '#11352A', amber: '#EFA73C', amberSoft: '#3A2A10', red: '#F08A82', redSoft: '#3C1A18' },
};

const base = t => `
${fonts}
:root{--paper:${t.paper};--surface:${t.surface};--ink:${t.ink};--muted:${t.muted};--line:${t.line};--accent:${t.accent};--accent-soft:${t.accentSoft};--amber:${t.amber};--amber-soft:${t.amberSoft};--red:${t.red};--red-soft:${t.redSoft};
--display:'Unbounded',sans-serif;--body:'Golos Text',sans-serif;--mono:'JetBrains Mono',monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--body);-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono)}
.chip{display:inline-flex;align-items:center;gap:8px;font:500 15px/1 var(--body);padding:8px 12px;border-radius:999px}
.chip i{width:8px;height:8px;border-radius:50%;display:inline-block}
.chip.orig{background:var(--amber-soft);color:var(--amber)} .chip.orig i{background:var(--amber)}
.chip.cons{background:var(--accent-soft);color:var(--accent)} .chip.cons i{background:var(--accent)}
.chip.miss{background:var(--red-soft);color:var(--red)} .chip.miss i{background:var(--red)}
`;

// ---------------------------------------------------------------------------------------------
const hero = t => `<style>${base(t)}
.wrap{width:1280px;height:640px;display:grid;grid-template-columns:1fr 540px;gap:56px;padding:72px 80px;align-items:center;
  background:radial-gradient(circle at 92% 8%, var(--accent-soft) 0, transparent 46%), var(--paper)}
.mark{display:flex;align-items:center;gap:16px;font:700 64px/1 var(--display);letter-spacing:-0.02em}
.mark b{color:var(--accent);font-weight:700}
.sect{width:62px;height:62px;border-radius:16px;background:var(--ink);color:var(--paper);display:grid;place-items:center;font:600 38px/1 var(--display)}
h1{font:500 30px/1.32 var(--body);margin-top:30px;max-width:560px;text-wrap:balance}
.sub{font:400 19px/1.5 var(--body);color:var(--muted);margin-top:18px;max-width:540px}
.install{margin-top:34px;display:inline-flex;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px;font:400 15px/1 var(--mono);color:var(--muted)}
.install span{color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:30px 32px;box-shadow:0 24px 60px -30px rgba(0,0,0,.35)}
.cite{font:500 26px/1 var(--mono);display:flex;justify-content:space-between;align-items:baseline}
.cite small{font:400 14px/1 var(--body);color:var(--muted)}
.quote{margin-top:22px;font:400 18px/1.55 var(--body);border-left:3px solid var(--accent);padding-left:18px}
.quote mark{background:var(--accent-soft);color:var(--ink);padding:0 3px;border-radius:4px}
.foot{margin-top:24px;display:flex;flex-direction:column;gap:12px}
.src{font:400 14px/1.4 var(--body);color:var(--muted)}
</style>
<div class="wrap">
  <div>
    <div class="mark"><div class="sect">§</div><span>Lex<b>BG</b></span></div>
    <h1>Bulgarian law for AI assistants — current, verbatim, cited.</h1>
    <p class="sub">An open-source MCP server that compiles the current text of a law from every amending act — 2,000+ acts from parliament.bg, 17 EU acts, compliance maps. Runs locally.</p>
    <div class="install"><span>$</span> npx -y …/lexbg.tgz <em style="font-style:normal;font-family:var(--body);color:var(--muted)">· one line in Claude Desktop</em></div>
  </div>
  <div class="card">
    <div class="cite">чл. 12, ал. 1 ЗСч <small>Закон за счетоводството</small></div>
    <p class="quote">Счетоводната информация се съхранява … в следните срокове: 1. <mark>ведомости за заплати – 50 години</mark>, считано от 1 януари на отчетния период, следващ …</p>
    <div class="foot">
      <span class="chip cons"><i></i>Current text · compiled from 27 amending acts</span>
      <span class="src">ЗСч compiled through ДВ, бр. 67 от 2026 г. · чл. 12 unchanged since 2015</span>
    </div>
  </div>
</div>`;

// ---------------------------------------------------------------------------------------------
const timeline = t => {
  const W = 1280, H = 620, x0 = 100, x1 = 1180, y = 430;
  const start = Date.parse('2015-06-01'), end = Date.parse('2026-12-31');
  const X = d => x0 + ((Date.parse(d) - start) / (end - start)) * (x1 - x0);
  const years = []; for (let yr = 2016; yr <= 2026; yr++) years.push(yr);
  const direct = amend.filter(a => a.mode === 'direct').length;
  const hidden = amend.filter(a => a.mode === 'indirect').length;
  // A few annotations on staggered rows (row 0 is highest), each with a leader line to its dot.
  const notes = {
    '2016-11-15': { text: 'Закон за независимия финансов одит', row: 0, anchor: 'start' },
    '2017-11-22': { text: 'ЗИД на ЗДДС', row: 2, anchor: 'start' },
    '2024-08-07': { text: 'Закон за въвеждане на еврото', row: 2, anchor: 'end' },
    '2025-03-21': { text: 'Държавен бюджет 2025', row: 1, anchor: 'end' },
    '2025-07-18': { text: 'ЗИД на Наказателния кодекс', row: 0, anchor: 'end' },
  };
  const rowY = r => y - 190 + r * 34;
  const stack = {};
  const dots = amend.map(a => {
    const isDirect = a.mode === 'direct';
    const k = `${isDirect}|${a.date.slice(0, 7)}`; stack[k] = (stack[k] ?? 0) + 1;
    const dy = (stack[k] - 1) * 24;
    return { ...a, isDirect, cx: X(a.date), cy: isDirect ? y + 74 + dy : y - 40 - dy };
  });
  const col = d => (d.isDirect ? t.accent : t.amber);
  return `<style>${base(t)}
  .wrap{width:${W}px;height:${H}px;padding:56px 80px 0;position:relative}
  h2{font:600 32px/1.25 var(--display);letter-spacing:-0.01em;max-width:1060px;text-wrap:balance}
  h2 em{font-style:normal;color:var(--amber)}
  p.lead{font:400 18px/1.5 var(--body);color:var(--muted);margin-top:14px;max-width:900px}
  svg{position:absolute;left:0;top:0}
  .legend{position:absolute;right:80px;bottom:34px;display:flex;gap:24px;font:500 15px/1 var(--body);color:var(--muted)}
  .legend span{display:flex;align-items:center;gap:8px}
  .legend i{width:12px;height:12px;border-radius:50%;display:inline-block}
  </style>
  <div class="wrap">
    <h2><em>${hidden} of ${amend.length}</em> changes to the Accounting Act since 2015 were made inside other laws</h2>
    <p class="lead">Only ${direct} were acts titled “amending the Accounting Act”. LexBG reads every act parliament adopts and links the hidden ones too.</p>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Golos Text">
      <line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${t.line}" stroke-width="2"/>
      ${years.map(yr => `<line x1="${X(`${yr}-01-01`)}" x2="${X(`${yr}-01-01`)}" y1="${y - 5}" y2="${y + 5}" stroke="${t.muted}" stroke-width="1.5"/>
        <text x="${X(`${yr}-01-01`)}" y="${y + 26}" text-anchor="middle" fill="${t.muted}" font-family="JetBrains Mono" font-size="13">${yr}</text>`).join('')}
      <circle cx="${X('2015-11-24')}" cy="${y}" r="9" fill="${t.ink}"/>
      <text x="${X('2015-11-24') - 12}" y="${y + 52}" text-anchor="start" fill="${t.ink}" font-weight="600" font-size="14">Adopted · ДВ 95/2015</text>
      ${dots.map(d => `<line x1="${d.cx}" x2="${d.cx}" y1="${y}" y2="${d.cy}" stroke="${col(d)}" stroke-opacity=".4" stroke-width="1.5"/>
        <circle cx="${d.cx}" cy="${d.cy}" r="7.5" fill="${col(d)}"/>`).join('')}
      ${dots.filter(d => notes[d.date] && !d.isDirect).map(d => {
        const n = notes[d.date]; const ly = rowY(n.row);
        return `<line x1="${d.cx}" x2="${d.cx}" y1="${d.cy - 8}" y2="${ly + 6}" stroke="${t.muted}" stroke-width="1" stroke-dasharray="2 3"/>
          <text x="${d.cx + (n.anchor === 'start' ? -4 : 4)}" y="${ly}" text-anchor="${n.anchor}" fill="${t.ink}" font-size="14">${n.text}</text>`;
      }).join('')}
      <text x="${X('2024-08-14')}" y="${y + 74 + 52}" text-anchor="middle" fill="${t.accent}" font-size="14">ЗИД на Закона за счетоводството</text>
    </svg>
    <div class="legend"><span><i style="background:${t.amber}"></i>Inside another law (${hidden})</span><span><i style="background:${t.accent}"></i>Amending act for the law (${direct})</span></div>
  </div>`;
};

// ---------------------------------------------------------------------------------------------
const flow = t => `<style>${base(t)}
.wrap{width:1280px;height:420px;padding:56px 70px;display:flex;flex-direction:column;gap:34px}
h2{font:600 30px/1.2 var(--display)}
.row{display:grid;grid-template-columns:1fr 34px 1fr 34px 1fr 34px 1fr;align-items:stretch}
.box{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 22px 20px;display:flex;flex-direction:column;gap:10px}
.box .k{font:600 13px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.box h3{font:600 20px/1.25 var(--body)}
.box p{font:400 15px/1.45 var(--body);color:var(--muted)}
.box code{font:400 13.5px/1.4 var(--mono);color:var(--accent)}
.box.hl{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.arr{display:grid;place-items:center;color:var(--muted);font:500 22px/1 var(--body)}
</style>
<div class="wrap">
  <h2>How it works</h2>
  <div class="row">
    <div class="box"><span class="k">Official sources</span><h3>parliament.bg<br>EUR&#8209;Lex</h3><p>Every act the National Assembly adopts; EU acts in Bulgarian via the Publications Office API.</p></div>
    <div class="arr">→</div>
    <div class="box"><span class="k">Every Monday</span><h3>Weekly build</h3><p>GitHub Actions parses acts, links amendments, runs tests and search evals.</p><code>.github/workflows/data.yml</code></div>
    <div class="arr">→</div>
    <div class="box hl"><span class="k">On your machine</span><h3>lexbg.db · 6 MB</h3><p>Downloaded once, checksum-verified, updated in the background. SQLite + full-text search.</p></div>
    <div class="arr">→</div>
    <div class="box"><span class="k">MCP</span><h3>Claude & any MCP client</h3><p>10 read-only tools, 4 workflow prompts. Answers quote the law and cite it.</p></div>
  </div>
</div>`;

// ---------------------------------------------------------------------------------------------
const example = t => `<style>${base(t)}
.wrap{width:1280px;height:660px;padding:56px 90px;display:flex;flex-direction:column;gap:22px}
.q{align-self:flex-end;max-width:760px;background:var(--ink);color:var(--paper);font:400 19px/1.5 var(--body);padding:18px 22px;border-radius:20px 20px 6px 20px}
.tools{display:flex;gap:10px;flex-wrap:wrap}
.tool{font:400 14px/1 var(--mono);color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:9px 14px}
.tool b{color:var(--accent);font-weight:500}
.a{background:var(--surface);border:1px solid var(--line);border-radius:20px 20px 20px 6px;padding:26px 30px;display:flex;flex-direction:column;gap:16px;max-width:1000px}
.a h4{font:600 22px/1.35 var(--body)}
.a p{font:400 17px/1.55 var(--body)}
blockquote{font:400 16.5px/1.55 var(--body);border-left:3px solid var(--accent);padding:4px 0 4px 18px;color:var(--ink)}
blockquote .c{display:block;margin-top:8px;font:500 14px/1 var(--mono);color:var(--accent)}
.note{font:400 14px/1.5 var(--body);color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap}
.cap{font:500 13px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
</style>
<div class="wrap">
  <span class="cap">Example · Claude Desktop with LexBG</span>
  <div class="q">Колко години трябва да пазя ведомостите за заплати? Променял ли се е този текст?</div>
  <div class="tools"><span class="tool"><b>search_law</b>("ведомости за заплати срок")</span><span class="tool"><b>get_provision</b>(ЗСч, чл. 12, ал. 1)</span><span class="tool"><b>what_changed</b>(ЗСч, article: 12)</span></div>
  <div class="a">
    <h4>50 години — ведомостите за заплати се пазят 50 години от 1 януари на следващия отчетен период.</h4>
    <blockquote>„Счетоводната информация се съхранява … в следните срокове: 1. ведомости за заплати – 50 години, считано от 1 януари на отчетния период, следващ отчетния период, за който се отнасят“<span class="c">чл. 12, ал. 1, т. 1 ЗСч</span></blockquote>
    <p>Счетоводните регистри и финансовите отчети се пазят 10 години (т. 2), а останалите носители — три години (т. 3).</p>
    <div class="row"><span class="chip cons"><i></i>Current text compiled through ДВ 67/2026</span><span class="chip cons"><i></i>чл. 12 unchanged since 2015</span></div>
    <p class="note">Research only, not legal advice — verify in Държавен вестник or with an accountant.</p>
  </div>
</div>`;

const shots = [
  ['hero', hero, 1280, 640],
  ['amendments', timeline, 1280, 620],
  ['how-it-works', flow, 1280, 420],
  ['example', example, 1280, 660],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--headless=new'] });
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const [name, tpl, w, h] of shots) {
  for (const [mode, t] of Object.entries(THEMES)) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><meta charset="utf-8">${tpl(t)}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(out, `${name}${mode === 'dark' ? '-dark' : ''}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    console.log('wrote', path.relative(process.cwd(), file));
  }
}
await browser.close();
