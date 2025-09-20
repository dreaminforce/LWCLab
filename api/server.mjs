import dotenv from 'dotenv';

dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

const PORT = 3001;
const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GEN_DIR = path.resolve(process.cwd(), 'src/modules/gen/preview');

// ---- helpers ----
function sanitizeHtml(html) {
  let s = String(html ?? '');

  // strip script tags
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // convert framework-y event attrs to LWC (e.g., @click / (click))
  s = s.replace(/@\s*([a-z]+)\s*=\s*"([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*"/g, 'on$1={$2}');
  s = s.replace(/\(\s*([a-z]+)\s*\)\s*=\s*"([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*"/g, 'on$1={$2}');

  // convert inline handlers onclick="handle()" or onclick="handle" → onclick={handle}
  s = s.replace(/on([a-z]+)\s*=\s*"\s*([A-Za-z_]\w*)\s*\(\s*\)\s*"/g, 'on$1={$2}');
  s = s.replace(/on([a-z]+)\s*=\s*"\s*([A-Za-z_]\w*)\s*"/g, 'on$1={$2}');

  // normalize onclick={this.handle} → onclick={handle}
  s = s.replace(/on([a-z]+)\s*=\s*{\s*this\.([A-Za-z_]\w*)\s*}/g, 'on$1={$2}');

  // final guard: no quoted inline handlers remain
  if (/\son[a-z]+\s*=\s*["']/i.test(s)) {
    throw new Error('Inline event handlers must use LWC syntax, e.g. onclick={handleClick}.');
  }

  return s.trim();
}

function ensureHandlerStubs(js, handlerNames) {
  let code = String(js ?? '');
  const classHeaderRe = /export\s+default\s+class\s+Preview\s+extends\s+LightningElement\s*{/;
  if (!classHeaderRe.test(code)) {
    throw new Error('JS must export class Preview extends LightningElement.');
  }

  // add stubs for any handlers referenced in HTML but missing in JS
  const missing = handlerNames.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(code));
  if (missing.length > 0) {
    const stubs = '\n' + missing.map((n) => `${n}(event) { /* auto-added */ }\n`).join('') + '\n';
    code = code.replace(classHeaderRe, (m) => m + stubs);
  }
  return code;
}

async function writePreviewFiles({ html, js, css }) {
  await fs.mkdir(GEN_DIR, { recursive: true });
  await fs.writeFile(path.join(GEN_DIR, 'preview.html'), html, 'utf8');
  await fs.writeFile(path.join(GEN_DIR, 'preview.js'), js, 'utf8');
  await fs.writeFile(path.join(GEN_DIR, 'preview.css'), css ?? '', 'utf8');
}

const STUB = {
  html: `<template>
  <div style="padding:12px; font:500 16px/1.4 system-ui, sans-serif;">
    Waiting for AI component…
  </div>
</template>`,
  js: `import { LightningElement } from 'lwc';
export default class Preview extends LightningElement {}`,
  css: `:host{display:block;}`
};

async function resetPreviewToStub() {
  await writePreviewFiles(STUB);
}

// ---- OpenAI system prompt ----
const SYSTEM = `
You generate **valid LWC component source** as JSON.

Design focus:
- Deliver polished, production-ready UI with thoughtful layouts, balanced color, generous spacing, and tasteful micro-interactions (e.g., hover/focus effects).
- Avoid bare-bones markup; every component should feel visually complete, accessible, and adaptable across desktop and mobile breakpoints.

Rules (apply for create or edit):
- Return a JSON object: { \"html\": string, \"js\": string, \"css\": string } ONLY (no markdown).
- Use **plain HTML** (no lightning-base-components, no external imports).
- The HTML must be a full <template>...</template>.
- The JS must be:
    import { LightningElement, api, track } from 'lwc';
    export default class Preview extends LightningElement { /* methods referenced in template must exist here */ }
- **Event handlers**: use LWC syntax (e.g., onclick={handleClick}) and define those class methods.
  Do NOT use inline handlers like onclick=\"...\".
- Include CSS that achieves the refined visual design; only return \"\" if the instruction explicitly prohibits styling.
- Component class and filenames are fixed: Preview / preview.html/js/css.
- No network calls or remote images.

If 'base' files are provided, EDIT them to satisfy the instruction with **minimal necessary changes**.
Return the **full** files (html/js/css), not a diff.
`;

// ---- routes ----
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, base } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const baseHtml = typeof base?.html === 'string' ? base.html : '';
    const baseJs = typeof base?.js === 'string' ? base.js : '';
    const baseCss = typeof base?.css === 'string' ? base.css : '';

    const hasBase = !!(baseHtml || baseJs || baseCss);

    const userText = hasBase
      ? `You are editing an existing LWC.
Instruction:
${prompt}

Current files to edit:
---HTML---
${baseHtml}
---JS---
${baseJs}
---CSS---
${baseCss}

Return ONLY JSON with keys "html","js","css" (no backticks).`
      : `Create a new LWC based on this instruction:
${prompt}

Return ONLY JSON with keys "html","js","css" (no backticks).`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText },
      ],
      temperature: 0.2,
    });

    const content = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    // sanitize + validate
    const html = sanitizeHtml(parsed.html);
    let js = String(parsed.js ?? '');
    const css = String(parsed.css ?? '');

    if (!html.includes('<template')) {
      return res.status(422).json({ error: 'HTML must contain <template>…</template>' });
    }
    if (!/export\s+default\s+class\s+Preview\s+extends\s+LightningElement/.test(js)) {
      return res.status(422).json({ error: 'JS must export class Preview extends LightningElement' });
    }

    // ensure handlers referenced in HTML exist in JS
    const handlerNames = Array.from(html.matchAll(/on[a-z]+\s*=\s*{\s*([A-Za-z_]\w*)\s*}/g)).map(m => m[1]);
    js = ensureHandlerStubs(js, handlerNames);

    // write files
    await writePreviewFiles({ html, js, css });

    return res.json({ ok: true, module: 'gen/preview', code: { html, js, css } });
  } catch (err) {
    console.error(err);
    const msg = err?.message || 'Generation failed';
    return res.status(500).json({ error: msg });
  }
});

// Clean the preview files to stub on demand (used by the UI at page load)
app.post('/api/reset', async (req, res) => {
  try {
    await resetPreviewToStub();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ---- boot ----
await resetPreviewToStub();

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
