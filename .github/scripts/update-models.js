// Google migró la página de deprecaciones de ai.google.dev (HTML estático con
// <h2> + <table>) a Google AI Studio (app Angular). La URL clásica redirige y
// sirve un shell HTML cuyo markdown fuente va embebido en <noscript><pre>.
// Además existe un endpoint markdown canónico, anunciado en llms.txt:
// https://aistudio.google.com/docs/deprecations.md
//
// Estrategia: fetch al .md canónico → fallback a la URL clásica → parseo
// markdown ({% table %}) → fallback al parser legacy de HTML → abort si 0.

const SOURCE_MD_URL = 'https://aistudio.google.com/docs/deprecations.md';
const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/deprecations';
const DATA_PATH = 'data.js';

const fs = require('fs');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; GeminiModelsBot/1.0)',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchText(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return res.text();
}

async function fetchSource() {
  try {
    const md = await fetchText(SOURCE_MD_URL);
    if (md.includes('{% table %}')) return md;
    console.warn('Markdown endpoint responded without tables, falling back to classic URL');
  } catch (err) {
    console.warn(`Markdown endpoint failed (${err.message}), falling back to classic URL`);
  }
  return fetchText(SOURCE_URL);
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Extrae el markdown de la respuesta, venga del endpoint .md (ya es markdown
// limpio) o del shell híbrido de AI Studio (markdown dentro de <noscript><pre>).
function extractMarkdown(text) {
  if (/<html/i.test(text) || /<!doctype/i.test(text)) {
    const m = text.match(/<noscript>\s*<pre[^>]*>([\s\S]*?)<\/pre>/i);
    return m ? decodeEntities(m[1]) : '';
  }
  return text;
}

function cleanCell(text) {
  return decodeEntities(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [texto](url) → texto
    .replace(/`/g, '')
    .trim();
}

function isValidModelName(name) {
  if (!name) return false;
  return name.split('-').length >= 2;
}

// Un bloque {% table %} ... {% /table %}: las filas son grupos de bullets
// ("* celda") separados por "---". La primera fila es el header.
function parseTableBlock(block, family, previewCtx) {
  const models = [];

  const rows = [];
  let current = [];
  for (const line of block) {
    if (/^\s*---\s*$/.test(line)) {
      if (current.length) rows.push(current);
      current = [];
    } else if (/^\s*\*\s?/.test(line)) {
      current.push(line.replace(/^\s*\*\s?/, ''));
    }
  }
  if (current.length) rows.push(current);

  if (rows.length < 2) return models;

  // Exigir "Model" como primera celda descarta las tablas de agentes
  // (header "Agent") y otras que no sean listas de modelos.
  const header = rows[0].map(cleanCell);
  if ((header[0] || '').toLowerCase() !== 'model') return models;

  for (const row of rows.slice(1)) {
    const cells = row.map(cleanCell);
    if (cells.length < 3) continue;

    const modelName = cells[0] || '';
    if (!modelName || modelName.includes('|') || !isValidModelName(modelName)) continue;

    // El replacement puede traer prosa entre paréntesis: quedarnos con el nombre
    let replacement = (cells[3] || '').trim();
    const paren = replacement.indexOf('(');
    if (paren > 0) replacement = replacement.slice(0, paren).trim();

    models.push({
      name: modelName,
      family,
      isPreview: previewCtx || modelName.toLowerCase().includes('preview'),
      releaseDate: cells[1] || '',
      shutdownDate: cells[2] || '',
      replacement,
    });
  }

  return models;
}

// "## Familia models" fija la familia; "### Preview models" marca contexto
// preview hasta el siguiente heading (las tablas de esa subsección heredan
// isPreview); el resto de subsecciones ("Deprecated models", etc.) no.
function parseMarkdown(md) {
  const models = [];
  const lines = md.split('\n');
  let family = '';
  let previewCtx = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const h2 = line.match(/^##\s+([^{%]+?)\s*(?:\{|$)/);
    if (h2) {
      family = h2[1].trim();
      previewCtx = false;
      i++;
      continue;
    }

    const h3 = line.match(/^###\s+(.+?)\s*(?:\{|$)/);
    if (h3) {
      previewCtx = /^preview/i.test(h3[1].trim());
      i++;
      continue;
    }

    if (/^\s*\{%\s*table\s*%\}/.test(line)) {
      const block = [];
      i++;
      while (i < lines.length && !/^\s*\{%\s*\/table\s*%\}/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      i++; // consumir {% /table %}
      models.push(...parseTableBlock(block, family, previewCtx));
      continue;
    }

    i++;
  }

  return models;
}

// Parser legacy del formato antiguo (<h2> seguido de <table>), por si Google
// revierte la migración. Mantenido como último recurso.
function parseLegacyHTML(html) {
  const models = [];
  const h2Regex = /<h2[^>]*>([^<]+)<\/h2>/g;
  let h2Match;
  const headings = [];

  while ((h2Match = h2Regex.exec(html)) !== null) {
    const text = h2Match[1].trim();
    if (text && (text.includes('Gemini') || text.includes('model'))) {
      headings.push({ text, end: h2Match.index + h2Match[0].length });
    }
  }

  for (const h2 of headings) {
    const afterH2 = html.slice(h2.end);
    const tableMatch = afterH2.match(/^\s*<table[^>]*>([\s\S]*?)<\/table>/);
    if (!tableMatch) continue;

    const tableContent = tableMatch[1];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    let isPreview = false;
    let isFirstRow = true;

    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
      const rowContent = rowMatch[1];
      const cellRegex = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
      let cellMatch;
      const cells = [];

      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        const text = cellMatch[2].replace(/<[^>]*>/g, '').trim();
        cells.push({ tag: cellMatch[1].toUpperCase(), text });
      }

      if (isFirstRow) {
        isFirstRow = false;
        if (cells.some(c => c.text.toLowerCase().includes('model') && c.text.toLowerCase().includes('date'))) continue;
      }

      const texts = cells.map(c => c.text);
      if (texts.length === 1 && texts[0].toLowerCase().includes('preview')) {
        isPreview = true;
        continue;
      }

      if (texts.length >= 3) {
        const modelName = texts[0]?.replace(/`/g, '').trim() || '';
        if (!modelName || modelName.includes('|') || !isValidModelName(modelName)) continue;

        models.push({
          name: modelName,
          family: h2.text,
          isPreview: isPreview || modelName.toLowerCase().includes('preview'),
          releaseDate: texts[1] || '',
          shutdownDate: texts[2] || '',
          replacement: texts[3]?.replace(/`/g, '').trim() || '',
        });
      }
    }
  }

  return models;
}

function parseSource(text) {
  const md = extractMarkdown(text);
  if (md) {
    const models = parseMarkdown(md);
    if (models.length > 0) return models;
  }
  return parseLegacyHTML(text);
}

function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function generateFallbackCode(models) {
  const entries = models.map(m =>
    `    { name: '${esc(m.name)}', family: '${esc(m.family)}', isPreview: ${m.isPreview}, releaseDate: '${esc(m.releaseDate)}', shutdownDate: '${esc(m.shutdownDate)}', replacement: '${esc(m.replacement)}' }`
  );
  return `const FALLBACK_MODELS = [\n${entries.join(',\n')}\n];`;
}

function generateTimestampCode() {
  const now = new Date().toISOString();
  return `const DATA_PARSED_AT = '${now}';`;
}

async function main() {
  console.log('Fetching source page...');
  const text = await fetchSource();

  console.log('Parsing models...');
  const models = parseSource(text);
  const families = [...new Set(models.map(m => m.family))];
  console.log(`Found ${models.length} models in ${families.length} families: ${families.join(', ')}`);

  if (models.length === 0) {
    console.error('No models found, aborting');
    process.exit(1);
  }
  if (models.length < 30) {
    console.warn(`Warning: unusually low model count (${models.length}) — source layout may have changed`);
  }

  console.log('Updating data.js...');
  let dataContent = fs.readFileSync(DATA_PATH, 'utf8');

  const fallbackStart = dataContent.indexOf('const FALLBACK_MODELS = [');
  // Empezar el reemplazo en el inicio de línea: si no, cada ejecución acumula
  // el indent previo y la línea crece espacio a espacio por run
  const lineStart = dataContent.lastIndexOf('\n', fallbackStart) + 1;
  const fallbackEnd = dataContent.indexOf('];', fallbackStart) + 2;

  if (fallbackStart === -1) {
    console.error('Could not find FALLBACK_MODELS constant');
    process.exit(1);
  }

  const newCode = generateFallbackCode(models);
  dataContent = dataContent.slice(0, lineStart) + newCode + dataContent.slice(fallbackEnd);

  // El ancla ^[ \t]* con /m consume el indent de la línea y lo normaliza
  const tsRegex = /^[ \t]*const DATA_PARSED_AT = '[^']+';/m;
  const newTs = generateTimestampCode();
  if (tsRegex.test(dataContent)) {
    dataContent = dataContent.replace(tsRegex, newTs);
  } else {
    console.error('Could not find DATA_PARSED_AT constant');
    process.exit(1);
  }

  fs.writeFileSync(DATA_PATH, dataContent);
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
