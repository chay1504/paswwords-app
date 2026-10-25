// Builds the static sites: dist/vault and dist/codes (each deployable on its own),
// and dist/site: the landing page with both apps inside it at /vault/ and /codes/.
// No bundler or network access needed.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_REVALIDATE_PATHS, netlifyHeaders, vercelConfig } from './headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const PORTALS = ['vault', 'codes'];
const PORTAL_FILES = ['index.html', 'app.js', 'controller.js', 'manifest.webmanifest'];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const posix = (path) => path.split(sep).join('/');

async function build(portal) {
  const out = join(dist, portal);
  await mkdir(out, { recursive: true });

  await cp(join(root, 'shared'), join(out, 'shared'), { recursive: true });
  await cp(join(root, portal, 'icons'), join(out, 'icons'), { recursive: true });
  for (const name of PORTAL_FILES) {
    let text = await readFile(join(root, portal, name), 'utf8');
    // In the source tree the shared code sits beside the portal; in dist it sits inside it.
    if (name.endsWith('.js')) text = text.replaceAll("'../shared/", "'./shared/");
    await writeFile(join(out, name), text);
  }
  await writeFile(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

  // Files the service worker keeps for offline use (not licences or host config).
  const files = [];
  for await (const path of walk(out)) {
    const rel = posix(relative(out, path));
    if (rel.endsWith('.txt')) continue;
    files.push(rel);
  }
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) hash.update(rel).update(await readFile(join(out, rel)));
  const version = hash.digest('hex').slice(0, 12);

  const template = await readFile(join(root, 'scripts', 'sw.template.js'), 'utf8');
  const precache = ['./', ...files.map((f) => `./${f}`)];
  await writeFile(
    join(out, 'sw.js'),
    template
      .replaceAll('__PORTAL__', portal)
      .replaceAll('__VERSION__', version)
      .replace('__FILES__', JSON.stringify(precache, null, 2)),
  );
  await writeFile(join(out, '_headers'), netlifyHeaders());
  await writeFile(join(out, 'vercel.json'), `${JSON.stringify(vercelConfig(), null, 2)}\n`);

  let bytes = 0;
  for (const rel of files) bytes += (await stat(join(out, rel))).size;
  return { portal, version, files: files.length, kb: Math.round(bytes / 1024) };
}

// Fail the build if the apps could reach another server.
async function assertNoRemoteUrls() {
  const problems = [];
  for (const portal of PORTALS) {
    for await (const path of walk(join(dist, portal))) {
      if (!/\.(html|js|css|webmanifest)$/.test(path) || path.includes(`${sep}vendor${sep}`)) continue;
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/https?:\/\/[^\s'"<>)]+/g)) {
        if (!match[0].startsWith('http://www.w3.org/')) problems.push(`${relative(dist, path)}: ${match[0]}`);
      }
    }
  }
  if (problems.length) throw new Error(`Remote URLs found:\n${problems.join('\n')}`);
}

// Landing page + video, with both apps nested so one deploy serves everything.
async function buildSite() {
  const src = join(root, 'site');
  const out = join(dist, 'site');
  await mkdir(join(out, 'assets'), { recursive: true });
  for (const name of ['index.html', 'site.css', 'site.js']) await cp(join(src, name), join(out, name));
  await cp(join(root, 'shared', 'fonts'), join(out, 'fonts'), { recursive: true });
  await cp(join(root, 'vault', 'icons', 'icon.svg'), join(out, 'assets', 'vault.svg'));
  await cp(join(root, 'codes', 'icons', 'icon.svg'), join(out, 'assets', 'codes.svg'));
  await mkdir(join(out, 'media'), { recursive: true });
  for (const name of ['how-it-works.mp4', 'poster.jpg']) {
    try {
      await cp(join(src, 'media', name), join(out, 'media', name));
    } catch {
      console.warn(`warning: site/media/${name} is missing; render the video first`);
    }
  }
  for (const portal of PORTALS) await cp(join(dist, portal), join(out, portal), { recursive: true });
  // Host config for the combined site replaces the per-app copies.
  for (const portal of PORTALS) {
    await rm(join(out, portal, 'vercel.json'), { force: true });
    await rm(join(out, portal, '_headers'), { force: true });
  }
  await writeFile(join(out, '_headers'), netlifyHeaders(SITE_REVALIDATE_PATHS));
  await writeFile(join(out, 'vercel.json'), `${JSON.stringify(vercelConfig(SITE_REVALIDATE_PATHS), null, 2)}
`);
  let bytes = 0;
  for await (const path of walk(out)) bytes += (await stat(path)).size;
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

await rm(dist, { recursive: true, force: true });
const results = [];
for (const portal of PORTALS) results.push(await build(portal));
await assertNoRemoteUrls();
const siteMb = await buildSite();
for (const r of results) console.log(`${r.portal}: ${r.files} files, ${r.kb} KB, cache version ${r.version}`);
console.log(`site: landing page + /vault/ + /codes/, ${siteMb} MB`);
console.log(`Built to ${dist}`);
