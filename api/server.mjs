import dotenv from 'dotenv';

dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import jsforce from 'jsforce';
import JSZip from 'jszip';

const PORT = 3001;
const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODELS = {
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
};
const GENERATION_TEMPERATURE = 0.2;

const GEN_DIR = path.resolve(process.cwd(), 'src/modules/gen/preview');
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_API_VERSION = process.env.SF_API_VERSION || '60.0';
const DEFAULT_LWC_TARGETS = ['lightning__AppPage', 'lightning__HomePage', 'lightning__RecordPage'];
const ALLOWED_LWC_TARGETS = new Set(DEFAULT_LWC_TARGETS);

const DEPLOY_TIMEOUT_MS = Number(process.env.SF_DEPLOY_TIMEOUT_MS || '') || 5 * 60 * 1000;
const DEPLOY_POLL_INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDeployCompletion(conn, deployId, timeoutMs = DEPLOY_TIMEOUT_MS, pollIntervalMs = DEPLOY_POLL_INTERVAL_MS) {
  if (!deployId) {
    throw new Error('Missing deployment id.');
  }

  const deadline = Date.now() + timeoutMs;
  let lastResult = null;

  while (Date.now() <= deadline) {
    lastResult = await conn.metadata.checkDeployStatus(deployId, true);
    if (lastResult?.done) {
      return lastResult;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error('Deployment timed out while waiting for Salesforce to finish.');
}

// ---- helpers ----
function sanitizeHtml(html, info = {}) {
  let s = String(html ?? '');

  // strip script tags
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  const mergeClassAttributes = (staticPart, dynamicPart) => {
    info.mergeClasses = true;
    const cleanedStatic = String(staticPart || '').replace(/\s+/g, ' ').trim();
    const escapedStatic = cleanedStatic.replace(/"/g, '\"');
    const expression = String(dynamicPart || '').trim();
    return `class={mergeClasses("${escapedStatic}", ${expression})}`;
  };

  const staticThenDynamic = /class="([^"]+)"\s+class={(.+?)}(\s|>)/g;
  const dynamicThenStatic = /class={(.+?)}\s+class="([^"]+)"(\s|>)/g;

  s = s.replace(staticThenDynamic, (_, staticPart, dynamicPart, tail) => `${mergeClassAttributes(staticPart, dynamicPart)}${tail}`);
  s = s.replace(dynamicThenStatic, (_, dynamicPart, staticPart, tail) => `${mergeClassAttributes(staticPart, dynamicPart)}${tail}`);

  // convert framework-y event attrs to LWC (e.g., @click / (click))
  s = s.replace(/@\s*([a-z]+)\s*=\s*"([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*"/g, 'on$1={$2}');
  s = s.replace(/\(\s*([a-z]+)\s*\)\s*=\s*"([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*"/g, 'on$1={$2}');

  // convert inline handlers onclick="handle()" or onclick="handle" -> onclick={handle}
  s = s.replace(/on([a-z]+)\s*=\s*"\s*([A-Za-z_]\w*)\s*\(\s*\)\s*"/g, 'on$1={$2}');
  s = s.replace(/on([a-z]+)\s*=\s*"\s*([A-Za-z_]\w*)\s*"/g, 'on$1={$2}');

  // normalize onclick={this.handle} -> onclick={handle}
  s = s.replace(/on([a-z]+)\s*=\s*{\s*this\.([A-Za-z_]\w*)\s*}/g, 'on$1={$2}');

  // final guard: no quoted inline handlers remain
  if (/\son[a-z]+\s*=\s*["']/i.test(s)) {
    throw new Error('Inline event handlers must use LWC syntax, e.g. onclick={handleClick}.');
  }

  const attrTagRe = /<([a-zA-Z](?:[\w:-]*))([^<]*?)>/g;
  let tagMatch;
  while ((tagMatch = attrTagRe.exec(s)) !== null) {
    const attrChunk = tagMatch[2];
    if (!attrChunk) {
      continue;
    }
    const seen = new Set();
    const attrRe = /(\w[\w:-]*)(?=\s*=)/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrChunk)) !== null) {
      const name = attrMatch[1];
      if (seen.has(name)) {
        throw new Error(`Duplicate attribute "${name}" detected in HTML.`);
      }
      seen.add(name);
    }
  }

  return s.trim();
}

function ensureLightTemplate(html) {
  const s = String(html ?? '');
  if (!s.includes('<template')) return s;
  // already has render-mode=light?
  if (/\blwc:render-mode\s*=\s*["']light["']/.test(s)) return s;

  // inject the attribute on the root <template>
  return s.replace(
    /<template(\s[^>]*)?>/,
    (m, attrs = '') => `<template${attrs} lwc:render-mode="light">`
  );
}

function ensureLightClass(js) {
  let code = String(js ?? '');
  // already set?
  if (/static\s+renderMode\s*=\s*['"]light['"]/.test(code)) return code;

  // inject inside "export default class Preview extends LightningElement {"
  const re = /(export\s+default\s+class\s+Preview\s+extends\s+LightningElement\s*{)/;
  if (!re.test(code)) return code;

  return code.replace(re, `$1\n  static renderMode = 'light';\n`);
}

function ensureMergeClasses(js) {
  if (/\bmergeClasses\s*\(/.test(js)) {
    return js;
  }

  const classHeaderRe = /(export\s+default\s+class\s+Preview\s+extends\s+LightningElement\s*{)/;
  if (!classHeaderRe.test(js)) {
    return js;
  }

  const helperBody = `
  mergeClasses(...parts) {
    return parts
      .flat(Infinity)
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
  }
`;

  return js.replace(classHeaderRe, `$1${helperBody}`);
}

function normalizeConversation(history) {
  if (!Array.isArray(history)) {
    return [];
  }


  return history
    .map((entry) => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = (entry?.content ?? entry?.text ?? '').toString().trim();
      if (!content) {
        return null;
      }
      return { role, content: content.slice(0, 8000) };
    })
    .filter(Boolean);
}

function normalizeModelSelection(input) {
  const fallback = { provider: 'openai', model: DEFAULT_MODELS.openai };
  if (!input) {
    return fallback;
  }

  if (typeof input === 'string') {
    const [rawProvider, ...rest] = input.split(':');
    const providerKey = rawProvider === 'gemini' ? 'gemini' : rawProvider === 'openai' ? 'openai' : null;
    if (providerKey) {
      const joined = rest.join(':').trim();
      const selected = joined || DEFAULT_MODELS[providerKey];
      return { provider: providerKey, model: selected.slice(0, 200) };
    }
    const fallbackModel = rawProvider ? rawProvider.trim() : '';
    if (fallbackModel) {
      return { provider: 'openai', model: fallbackModel.slice(0, 200) };
    }
    return fallback;
  }

  const providerValue = input?.provider === 'gemini' ? 'gemini' : 'openai';
  const nameValue = typeof input?.name === 'string' && input.name.trim()
    ? input.name.trim()
    : DEFAULT_MODELS[providerValue];
  return { provider: providerValue, model: nameValue.slice(0, 200) };
}

function toGeminiModelPath(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return `models/${DEFAULT_MODELS.gemini}`;
  }
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

function buildGeminiContents(historyMessages, userText) {
  const contents = [];
  const safeHistory = Array.isArray(historyMessages) ? historyMessages : [];
  for (const entry of safeHistory) {
    const role = entry?.role === 'assistant' ? 'model' : 'user';
    const textValue = (entry?.content ?? '').toString().trim();
    if (!textValue) {
      continue;
    }
    contents.push({ role, parts: [{ text: textValue }] });
  }
  contents.push({ role: 'user', parts: [{ text: (userText || '').toString() }] });
  return contents;
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

function sanitizeBundleName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return '';
  }
  if (!/^[a-z][A-Za-z0-9_]*$/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const filtered = list
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value && ALLOWED_LWC_TARGETS.has(value));
  if (filtered.length > 0) {
    return Array.from(new Set(filtered));
  }
  return DEFAULT_LWC_TARGETS;
}

function createLightningBundleMetaXml(apiVersion = SF_API_VERSION, targets = DEFAULT_LWC_TARGETS) {
  const version = apiVersion || SF_API_VERSION;
  const normalizedTargets = normalizeTargets(targets);
  const targetXml = normalizedTargets
    .map((target) => `    <target>${target}</target>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>${version}</apiVersion>
  <isExposed>true</isExposed>
  <targets>
${targetXml}
  </targets>
</LightningComponentBundle>
`;
}

function createPackageXml(bundleName, apiVersion = SF_API_VERSION) {
  const version = apiVersion || SF_API_VERSION;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${bundleName}</members>
    <name>LightningComponentBundle</name>
  </types>
  <version>${version}</version>
</Package>
`;
}

async function loadGeneratedPreview() {
  try {
    const [html, js, css] = await Promise.all([
      fs.readFile(path.join(GEN_DIR, 'preview.html'), 'utf8'),
      fs.readFile(path.join(GEN_DIR, 'preview.js'), 'utf8'),
      fs.readFile(path.join(GEN_DIR, 'preview.css'), 'utf8'),
    ]);
    return { html, js, css };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function buildLwcDeployZip(bundleName, files, apiVersion = SF_API_VERSION, targets = DEFAULT_LWC_TARGETS) {
  const zip = new JSZip();
  zip.file('package.xml', createPackageXml(bundleName, apiVersion));
  const bundleFolder = zip.folder('lwc').folder(bundleName);
  bundleFolder.file(`${bundleName}.html`, files.html ?? '');
  bundleFolder.file(`${bundleName}.js`, files.js ?? '');
  bundleFolder.file(`${bundleName}.css`, files.css ?? '');
  bundleFolder.file(`${bundleName}.js-meta.xml`, createLightningBundleMetaXml(apiVersion, targets));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function extractDeployFailureMessage(result) {
  if (!result) {
    return 'Deployment failed';
  }
  const failures = result.details?.componentFailures;
  const items = Array.isArray(failures) ? failures : failures ? [failures] : [];
  const messages = items
    .map((item) => {
      if (!item) {
        return null;
      }
      const location = item.fileName ? `${item.fileName}${item.lineNumber ? `:${item.lineNumber}` : ''}` : '';
      const problem = item.problem || item.message || item.error;
      if (location && problem) {
        return `${location} - ${problem}`;
      }
      return problem || location || null;
    })
    .filter(Boolean);
  if (messages.length > 0) {
    return messages.join('\n');
  }
  return result.errorMessage || 'Deployment failed';
}

function normalizeComponentSuccesses(successes) {
  const items = Array.isArray(successes) ? successes : successes ? [successes] : [];
  return items
    .map((item) => ({
      fullName: item?.fullName || '',
      fileName: item?.fileName || '',
      created: item?.created ?? false,
      changed: item?.changed ?? false,
    }))
    .filter((entry) => entry.fullName || entry.fileName);
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
    Waiting for AI component...
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
- Deliver polished, production-ready UI with thoughtful layouts, balanced spacing, and accessible markup.

Rules (apply for create or edit):
- Return a JSON object: { "html": string, "js": string, "css": string } ONLY (no markdown).
- Prefer **Salesforce Lightning Design System (SLDS)** utility and component classes (e.g., slds-grid, slds-form, slds-input, slds-button, slds-card) over custom CSS.
- Avoid lightning-base-components (plain HTML + SLDS classes only).
- The HTML must be a full <template lwc:render-mode="light">...</template>.
- The JS must be:
    import { LightningElement, api, track } from 'lwc';
    export default class Preview extends LightningElement {
      static renderMode = 'light';
      /* methods referenced in template must exist here */
    }
- Event handlers must use LWC syntax (e.g., onclick={handleClick}); define those class methods.
- **CSS REQUIREMENT**
- **Never return empty CSS.** If no extra styling is needed, return at least:
  :host { display: block; }
- Keep custom CSS minimal and only when SLDS can’t express the styling.
- Component class and filenames are fixed: Preview / preview.html/js/css.
- No network calls or remote images.

If 'base' files are provided, EDIT them with **minimal necessary changes**.
Return the **full** files (html/js/css), not a diff.
`;

async function callOpenAi({ messages, model }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages,
    temperature: GENERATION_TEMPERATURE,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI response did not include any content.');
  }

  return content;
}

async function callGemini({ historyMessages, userText, model }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const modelPath = toGeminiModelPath(model);
  const url = `${GEMINI_API_BASE_URL}/${modelPath}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: buildGeminiContents(historyMessages, userText),
    system_instruction: {
      role: 'system',
      parts: [{ text: SYSTEM }],
    },
    generationConfig: {
      temperature: GENERATION_TEMPERATURE,
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const detail = data?.error?.message || data?.error?.status || raw || response.statusText;
    throw new Error(`Gemini request failed: ${detail}`);
  }

  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    const textParts = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    const combined = textParts.join('').trim();
    if (combined) {
      return combined;
    }
  }

  throw new Error('Gemini response did not include any content.');
}

// ---- routes ----
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, base, conversation, model } = req.body || {};
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

    const historyMessages = normalizeConversation(conversation);
    const { provider, model: modelName } = normalizeModelSelection(model);

    let rawContent;
    if (provider === 'gemini') {
      rawContent = await callGemini({ historyMessages, userText, model: modelName });
    } else {
      const openAiMessages = [
        { role: 'system', content: SYSTEM },
        ...historyMessages,
        { role: 'user', content: userText },
      ];
      rawContent = await callOpenAi({ messages: openAiMessages, model: modelName || DEFAULT_MODELS.openai });
    }

    const content = rawContent || '{}';
    const parsed = JSON.parse(content);

    // sanitize + validate
    const sanitizeInfo = {};
    const rawHtml = sanitizeHtml(parsed.html, sanitizeInfo);
    let js = String(parsed.js ?? '');
    const css = String(parsed.css ?? '');

    // enforce light DOM so SLDS can style the preview
    const htmlLight = ensureLightTemplate(rawHtml);
    js = ensureLightClass(js);

    if (sanitizeInfo.mergeClasses) {
      js = ensureMergeClasses(js);
    }

    // validate against the light DOM html & updated js
    if (!htmlLight.includes('<template')) {
      return res.status(422).json({ error: 'HTML must contain <template>...</template>' });
    }
    if (!/export\s+default\s+class\s+Preview\s+extends\s+LightningElement/.test(js)) {
      return res.status(422).json({ error: 'JS must export class Preview extends LightningElement' });
    }

    // ensure handlers referenced in HTML exist in JS (use htmlLight)
    const handlerNames = Array.from(htmlLight.matchAll(/on[a-z]+\s*=\s*{\s*([A-Za-z_]\w*)\s*}/g)).map(m => m[1]);
    js = ensureHandlerStubs(js, handlerNames);
    if (sanitizeInfo.mergeClasses) {
      js = ensureMergeClasses(js);
    }

    // write files (persist the transformed code)
    await writePreviewFiles({ html: htmlLight, js, css });

    // IMPORTANT: return the transformed code so the Code tab matches what was saved
    return res.json({ ok: true, module: 'gen/preview', code: { html: htmlLight, js, css } });
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

app.get('/api/preview', async (req, res) => {
  try {
    const files = await loadGeneratedPreview();
    if (!files) {
      return res.status(404).json({ error: 'No generated component available. Generate or update the component before refreshing.' });
    }
    res.json({ ok: true, code: files });
  } catch (error) {
    console.error('Failed to read generated preview', error);
    res.status(500).json({ error: 'Could not read generated component from disk.' });
  }
});

app.post('/api/preview', async (req, res) => {
  const { html, js, css } = req.body || {};
  const nextHtml = typeof html === 'string' ? html : '';
  const nextJs = typeof js === 'string' ? js : '';
  const nextCss = typeof css === 'string' ? css : '';

  if (!nextHtml.trim()) {
    return res.status(400).json({ error: 'HTML content is required to update the preview.' });
  }
  if (!nextHtml.includes('<template')) {
    return res.status(422).json({ error: 'HTML must contain <template>...</template>' });
  }

  try {
    const safeHtml = ensureLightTemplate(nextHtml);
    const safeJs = ensureLightClass(nextJs);

    await writePreviewFiles({ html: safeHtml, js: safeJs, css: nextCss });

    // IMPORTANT: return the transformed code
    res.json({ ok: true, code: { html: safeHtml, js: safeJs, css: nextCss } });
  } catch (error) {
    console.error('Failed to write generated preview', error);
    res.status(500).json({ error: 'Could not save generated component to disk.' });
  }
});

app.post('/api/deploy', async (req, res) => {
  const { username, password, loginUrl, bundleName, targets } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const normalizedBundleName = sanitizeBundleName(bundleName);
  if (!normalizedBundleName) {
    return res.status(400).json({ error: 'Enter a valid Lightning web component name (letters, numbers, underscores; must start with a lowercase letter).' });
  }

  const normalizedTargets = normalizeTargets(targets);

  let files;
  try {
    files = await loadGeneratedPreview();
  } catch (error) {
    console.error('Failed to load generated preview', error);
    return res.status(500).json({ error: 'Could not read generated component from disk.' });
  }

  if (!files) {
    return res.status(400).json({ error: 'No generated component available. Generate a component before deploying.' });
  }

  const resolvedLoginUrl = typeof loginUrl === 'string' && loginUrl.trim() ? loginUrl.trim() : SF_LOGIN_URL;

  try {
    const zipBuffer = await buildLwcDeployZip(normalizedBundleName, files, SF_API_VERSION, normalizedTargets);
    const conn = new jsforce.Connection({ loginUrl: resolvedLoginUrl, version: SF_API_VERSION });
    await conn.login(username, password);

    const deployStart = await conn.metadata.deploy(zipBuffer, { singlePackage: true });
    const deployId = typeof deployStart === 'string' ? deployStart : deployStart?.id;
    const result = deployStart && typeof deployStart === 'object' && deployStart.done && deployStart.details
      ? deployStart
      : await waitForDeployCompletion(conn, deployId);

    if (!result.success) {
      const message = extractDeployFailureMessage(result);
      return res.status(502).json({ error: message || 'Deployment failed' });
    }

    const successes = normalizeComponentSuccesses(result.details?.componentSuccesses);

    return res.json({
      ok: true,
      component: normalizedBundleName,
      targets: normalizedTargets,
      status: result.status,
      id: result.id || deployId,
      completedDate: result.completedDate,
      successes,
    });
  } catch (error) {
    console.error('Salesforce deployment failed', error);
    const message = error?.message || 'Deployment failed';
    return res.status(500).json({ error: message });
  }
});

// ---- boot ----
await resetPreviewToStub();

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
