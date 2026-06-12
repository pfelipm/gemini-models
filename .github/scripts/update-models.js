const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/deprecations';
const INDEX_PATH = 'index.html';

const fs = require('fs');

async function fetchHTML() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GeminiModelsBot/1.0)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.text();
}

function isValidModelName(name) {
  if (!name) return false;
  return name.split('-').length >= 2;
}

function parseHTML(html) {
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

function generateFallbackCode(models) {
  const entries = models.map(m =>
    `                { name: '${m.name}', family: '${m.family}', isPreview: ${m.isPreview}, releaseDate: '${m.releaseDate}', shutdownDate: '${m.shutdownDate}', replacement: '${m.replacement}' }`
  );
  return `        function loadFallbackData() {\n            return [\n${entries.join(',\n')}\n            ];\n        }`;
}

function generateTimestampCode() {
  const now = new Date().toISOString();
  return `        const DATA_PARSED_AT = '${now}';`;
}

async function main() {
  console.log('Fetching source page...');
  const html = await fetchHTML();

  console.log('Parsing models...');
  const models = parseHTML(html);
  console.log(`Found ${models.length} models in ${[...new Set(models.map(m => m.family))].length} families`);

  if (models.length === 0) {
    console.error('No models found, aborting');
    process.exit(1);
  }

  console.log('Updating index.html...');
  let indexContent = fs.readFileSync(INDEX_PATH, 'utf8');

  const fallbackStart = indexContent.indexOf('function loadFallbackData()');
  const fallbackEnd = indexContent.indexOf('}', indexContent.indexOf('];', fallbackStart)) + 1;

  if (fallbackStart === -1) {
    console.error('Could not find loadFallbackData function');
    process.exit(1);
  }

  const newCode = generateFallbackCode(models);
  indexContent = indexContent.slice(0, fallbackStart) + newCode + indexContent.slice(fallbackEnd);

  const tsRegex = /const DATA_PARSED_AT = '[^']+';/;
  const newTs = generateTimestampCode();
  if (tsRegex.test(indexContent)) {
    indexContent = indexContent.replace(tsRegex, newTs);
  } else {
    const scriptStart = indexContent.indexOf('<script>');
    indexContent = indexContent.slice(0, scriptStart + 8) + '\n    ' + newTs + indexContent.slice(scriptStart + 8);
  }

  fs.writeFileSync(INDEX_PATH, indexContent);
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
