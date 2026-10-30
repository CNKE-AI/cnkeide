import assert from 'node:assert/strict';

const values = new Map([['cnke.theme', 'aurora']]);
const classes = new Set(['app-root']);
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};
globalThis.document = {
  documentElement: {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
    style: {},
  },
};

const { useThemeStore, applyTheme, isThemeMode, nextTheme, THEMES } = await import('../renderer/src/store/themeStore.ts');
assert.equal(useThemeStore.getState().theme, 'aurora');
assert.equal(THEMES.length, 10);
assert.equal(new Set(THEMES.map(({ id }) => id)).size, THEMES.length);
assert.equal(isThemeMode('unknown'), false);
assert.equal(isThemeMode(null), false);
for (const [index, { id }] of THEMES.entries()) {
  assert.equal(isThemeMode(id), true);
  assert.equal(nextTheme(id), THEMES[(index + 1) % THEMES.length].id);
}

for (const source of THEMES) {
  for (const { id, scheme } of THEMES) {
    useThemeStore.getState().setTheme(source.id);
    useThemeStore.getState().setTheme(id);
    assert.equal(useThemeStore.getState().theme, id);
    assert.equal(values.get('cnke.theme'), id);
    assert.equal(document.documentElement.dataset.theme, id);
    assert.equal(document.documentElement.style.colorScheme, scheme);
    for (const candidate of THEMES) {
      assert.equal(classes.has(candidate.id), candidate.id === 'light' ? scheme === 'light' : candidate.id === id);
    }
    assert.ok(classes.has('app-root'));
  }
}
useThemeStore.getState().toggleTheme();
assert.equal(useThemeStore.getState().theme, 'dark');
localStorage.setItem = () => { throw new Error('storage unavailable'); };
assert.doesNotThrow(() => applyTheme('aurora'));
assert.ok(classes.has('aurora'));
const { readFileSync } = await import('node:fs');
const { default: postcss } = await import('postcss');
const css = postcss.parse(readFileSync(new URL('../renderer/src/index.css', import.meta.url), 'utf8'));
function rgb(color) {
  if (color.startsWith('#')) return color.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  const [h, s, l] = color.match(/[\d.]+/g).map(Number);
  const a = s / 100 * Math.min(l / 100, 1 - l / 100);
  return [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  });
}
function luminance(color) {
  const values = rgb(color).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
for (const { id } of THEMES.filter(({ id }) => !['dark', 'light', 'aurora'].includes(id))) {
  const tokens = {};
  css.walkRules(`:root.${id}`, (rule) => rule.walkDecls((decl) => { tokens[decl.prop] = decl.value; }));
  const checks = [
    ['--foreground', '--background'], ['--card-foreground', '--card'],
    ['--popover-foreground', '--popover'], ['--primary-foreground', '--primary'],
    ['--secondary-foreground', '--secondary'], ['--accent-foreground', '--accent'],
    ['--muted-foreground', '--background'], ['--muted-foreground', '--muted'],
    ['--primary', '--background'], ['--theme-secondary', '--background'],
    ['--code-fg', '--code-selection'],
  ];
  for (const token of ['fg', 'comment', 'keyword', 'function', 'string', 'number', 'type', 'error']) checks.push([`--code-${token}`, '--code-bg']);
  let minimum = Infinity;
  for (const [fg, bg] of checks) {
    assert.ok(tokens[fg] && tokens[bg], `${id}: missing ${fg}/${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    minimum = Math.min(minimum, ratio);
    assert.ok(ratio >= 4.5, `${id}: ${fg}/${bg} contrast ${ratio.toFixed(2)} < 4.5`);
  }
  assert.ok(contrast(tokens['--ring'], tokens['--background']) >= 3);
  assert.ok(contrast(tokens['--input'], tokens['--background']) >= 3);
  console.log(`PASS: ${id}, ${checks.length} text pairs, minimum contrast ${minimum.toFixed(2)}:1`);
}
console.log(`PASS: saved theme, ${THEMES.length}-theme cycle, ${THEMES.length ** 2} transitions, persistence, class isolation, color scheme, storage failure, CSS parsing and palette contrast`);
