#!/usr/bin/env node
/**
 * Nexplore SE Dashboard — sandbox sync
 *
 * Logs into the Nexplore sandbox, scrapes classes / sites / instructors / field trips
 * for FL, TX and GA, and rewrites the DATA / INSTRUCTORS / TRIPS arrays inside index.html.
 *
 * Credentials come from env (GitHub Actions secrets): NEX_EMAIL, NEX_PASSWORD.
 * They are never written to the output file or the logs.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const BASE = 'https://sandbox.nexploreusa.com';
const KEEP_STATES = { FL: 1, TX: 1, GA: 1 };
const STATE_FROM_NAME = { Florida: 'FL', Texas: 'TX', Georgia: 'GA' };
const INDEX = path.join(__dirname, '..', 'index.html');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MON_IDX = {}; MONTHS.forEach((m, i) => { MON_IDX[m] = i; });

/* ---------------- session ---------------- */

let COOKIES = {};

function cookieHeader() {
  return Object.entries(COOKIES).map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) COOKIES[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}

async function req(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NexploreDashboardSync/1.0)',
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      ...(opts.headers || {}),
    },
  });
  storeCookies(res);
  return res;
}

async function login(email, password) {
  await req(`${BASE}/login.php`);                 // pick up the initial session cookie
  const body = new URLSearchParams({ email, password, remember: '1', action: 'login' });
  const res = await req(`${BASE}/process.php`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (res.status >= 500) throw new Error(`Login endpoint returned ${res.status}`);

  const check = await req(`${BASE}/manage_classes.php`);
  const html = await check.text();
  if (/name=["']password["']/i.test(html) || /<title>\s*Login/i.test(html)) {
    throw new Error('Login failed — sandbox returned the login page. Check NEX_EMAIL / NEX_PASSWORD.');
  }
  return html;
}

async function getHtml(pageUrl) {
  const res = await req(pageUrl);
  if (res.status !== 200) throw new Error(`${pageUrl} returned ${res.status}`);
  return res.text();
}

/* ---------------- helpers ---------------- */

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase();
const stripStars = (s) => norm(s).replace(/\*+$/, '').trim();

function cellText($, tr, i) {
  const td = $(tr).children('td').eq(i);
  return norm(td.text());
}
function cellRaw($, tr, i) {
  return $(tr).children('td').eq(i).text() || '';
}

/** "Nov 13,20Dec 04,11,18Jan 15" -> [{m,d}, ...] in order */
function parseSessions(s) {
  const out = [];
  const re = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*([\d,\s]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const mon = MON_IDX[m[1]];
    for (const part of m[2].split(',')) {
      const d = part.trim();
      if (/^\d{1,2}$/.test(d)) out.push({ m: mon, d: Number(d) });
    }
  }
  return out;
}

/** Site cell carries annotations separated by wide gaps: "Name   ESE" -> "Name | ESE" */
function siteDisplayName(raw) {
  const parts = String(raw).split(/\t|\n|\s{3,}/).map(norm).filter(Boolean);
  if (!parts.length) return norm(raw);
  return parts.length > 1 ? `${parts[0]} | ${parts.slice(1).join(' | ')}` : parts[0];
}

/* ---------------- scrapers ---------------- */

function scrapeClasses(html) {
  const $ = cheerio.load(html);
  const rows = $('table tbody tr').toArray();
  if (!rows.length) throw new Error('Classes table had no rows — layout may have changed.');

  // Column indices shift when the app adds columns. Locate them from the header.
  const headers = $('table thead th').toArray().map((th) => lower($(th).text()));
  const expect = ['state', 'region', 'city', 'site'];
  expect.forEach((name, i) => {
    if (headers[i] && headers[i].indexOf(name) < 0) {
      console.warn(`  ! classes column ${i} is "${headers[i]}", expected "${name}"`);
    }
  });

  const out = [];
  let skippedTest = 0, skippedState = 0;

  for (const tr of rows) {
    if ($(tr).children('td').length < 9) continue;
    const state = cellText($, tr, 0);
    const rawSite = cellRaw($, tr, 3);
    const siteNorm = norm(rawSite);
    if (/test/i.test(siteNorm)) { skippedTest++; continue; }
    if (!KEEP_STATES[state]) { skippedState++; continue; }

    const instrCell = cellText($, tr, 5);
    const im = instrCell.match(/Instructor:\s*([^(]+?)\s*(?:\((\d+)\s*miles?\))?$/);
    const instructor = im ? im[1].trim() : '';
    if (/test/i.test(instructor)) { skippedTest++; continue; }

    const pc = cellText($, tr, 4).split('Course:');
    const dayCell = cellText($, tr, 7);
    const tm = dayCell.match(
      /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)/
    );
    const ses = parseSessions(cellText($, tr, 8));
    const first = ses[0], last = ses[ses.length - 1];

    out.push({
      state,
      region: cellText($, tr, 1),
      city: cellText($, tr, 2),
      site: siteDisplayName(rawSite),
      siteKey: lower(siteNorm),
      program: norm(pc[0] || ''),
      course: norm(pc[1] || ''),
      instructor,
      miles: im && im[2] ? Number(im[2]) : null,
      status: instructor ? 'filled' : 'open',
      startDate: first ? `${MONTHS[first.m]} ${first.d}` : '',
      endDate: last ? `${MONTHS[last.m]} ${last.d}` : '',
      sessions: ses.length,
      sessionDates: ses.map((x) => `${MONTHS[x.m]} ${x.d}`),
      time: tm ? `${tm[1].slice(0, 3)} ${tm[2]}-${tm[3]}` : '',
      psm: cellText($, tr, 6),
      day: tm ? tm[1] : '',
    });
  }

  console.log(`  classes: ${out.length} kept (${skippedState} out-of-state, ${skippedTest} test)`);
  if (!out.length) throw new Error('No classes parsed — refusing to publish an empty dashboard.');
  const undated = out.filter((c) => !c.startDate).length;
  if (undated) console.warn(`  ! ${undated} classes had no parseable dates`);
  return out;
}

function scrapeSchoolIds(html) {
  const $ = cheerio.load(html);
  const byName = {};
  $('table tbody tr').each((_, tr) => {
    const name = norm($(tr).children('td').eq(0).text());
    if (!name) return;
    const href = $(tr).find('a[href*="manage_school.php?id="]').attr('href') || '';
    const id = (href.match(/id=(\d+)/) || [])[1];
    if (id) byName[lower(name)] = id;
  });
  return byName;
}

async function fetchSchoolAddress(id) {
  const html = await getHtml(`${BASE}/manage_school.php?id=${id}`);
  const $ = cheerio.load(html);
  const val = (n) => norm($(`input[name="${n}"]`).attr('value') || '');
  return { address: val('address'), city: val('city'), state: val('state'), zip: val('zip') };
}

function scrapeInstructors(html, previousByName) {
  const $ = cheerio.load(html);
  const rows = $('table tbody tr').toArray();
  if (!rows.length) throw new Error('Instructor table had no rows — layout may have changed.');

  const out = [];
  for (const tr of rows) {
    if ($(tr).children('td').length < 14) continue;
    const st = STATE_FROM_NAME[cellText($, tr, 2)];
    if (!st) continue;
    const name = cellText($, tr, 0);
    if (/test/i.test(name)) continue;
    const key = lower(stripStars(name));
    out.push({
      name,
      training: cellText($, tr, 1),
      state: st,
      region: cellText($, tr, 3),
      psm: cellText($, tr, 4),
      hrFile: cellText($, tr, 5),
      phone: cellText($, tr, 6),
      email: cellText($, tr, 7),
      zip: cellText($, tr, 8).slice(0, 5),
      lastLogin: cellText($, tr, 13),
      isNew: !previousByName[key],
    });
  }
  console.log(`  instructors: ${out.length} in FL/TX/GA (${out.filter((i) => i.isNew).length} new since last sync)`);
  if (!out.length) throw new Error('No instructors parsed — refusing to publish.');
  return out;
}

function scrapeTrips(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('table tbody tr').each((_, tr) => {
    if ($(tr).children('td').length < 12) return;
    const st = cellText($, tr, 3);
    if (!KEEP_STATES[st]) return;
    const site = cellText($, tr, 2);
    if (/test/i.test(site)) return;
    const dd = cellText($, tr, 0).match(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*(.*)$/
    );
    const pc = cellText($, tr, 6).split('Course:');
    const teacher = cellText($, tr, 10);
    const tm = teacher.match(/^([^(]+?)\s*(?:\(\d+\s*miles?\))?$/);
    out.push({
      site,
      siteKey: lower(site),
      state: st,
      region: cellText($, tr, 4),
      city: cellText($, tr, 5),
      day: dd ? dd[1] : '',
      date: dd ? dd[2] : cellText($, tr, 0),
      time: cellText($, tr, 1),
      program: norm(pc[0] || ''),
      course: norm(pc[1] || ''),
      grade: cellText($, tr, 8),
      students: cellText($, tr, 9),
      psm: cellText($, tr, 11),
      instructor: tm ? tm[1].trim() : '',
      status: teacher ? 'assigned' : 'open',
    });
  });
  console.log(`  field trips: ${out.length}`);
  return out;
}

/* ---------------- geocoding ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(params) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=1&${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NexploreDashboardSync/1.0 (internal staffing map)' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j[0]) return { lat: Number(j[0].lat), lon: Number(j[0].lon) };
  } catch (_) { /* fall through */ }
  return null;
}

async function geocodeAddress(a, state) {
  const street = a.address.replace(/,+$/, '');
  const attempts = [
    `street=${encodeURIComponent(street)}&city=${encodeURIComponent(a.city)}&state=${state}`,
    `postalcode=${encodeURIComponent(a.zip)}&state=${state}`,
    `city=${encodeURIComponent(a.city)}&state=${state}`,
  ];
  for (const q of attempts) {
    const hit = await nominatim(q);
    await sleep(1100);                    // Nominatim asks for <= 1 req/sec
    if (hit) return hit;
  }
  return null;
}

/* ---------------- splice ---------------- */

/** Replace the array literal following `marker`, walking balanced brackets. */
function spliceArray(text, marker, json) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`Marker not found in index.html: ${marker}`);
  const start = text.indexOf('[', i);
  if (start < 0) throw new Error(`No array literal after ${marker}`);
  let depth = 0, end = -1;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error(`Unbalanced array after ${marker}`);
  return text.slice(0, start) + json + text.slice(end + 1);
}

/* ---------------- main ---------------- */

async function main() {
  const email = process.env.NEX_EMAIL;
  const password = process.env.NEX_PASSWORD;
  if (!email || !password) throw new Error('NEX_EMAIL and NEX_PASSWORD must be set.');

  let html = fs.readFileSync(INDEX, 'utf8');

  // Previous coordinates — reused so we only geocode genuinely new places.
  const prev = {};
  for (const marker of ['const DATA', 'const INSTRUCTORS', 'const TRIPS']) {
    const i = html.indexOf(marker);
    const start = html.indexOf('[', i);
    let depth = 0, end = -1;
    for (let k = start; k < html.length; k++) {
      if (html[k] === '[') depth++;
      else if (html[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
    }
    prev[marker] = JSON.parse(html.slice(start, end + 1));
  }

  const prevSites = {};
  for (const s of prev['const DATA']) {
    if (typeof s.lat === 'number') {
      prevSites[lower(s.name)] = s;
      prevSites[lower(String(s.name).split(' | ')[0])] = s;
    }
  }
  const prevZips = {};
  const prevInstrByName = {};
  for (const i of prev['const INSTRUCTORS']) {
    const z = String(i.zip || '').slice(0, 5);
    if (z && typeof i.lat === 'number') prevZips[z] = [i.lat, i.lon];
    prevInstrByName[lower(stripStars(i.name))] = i;
  }
  const prevTripSites = {};
  for (const t of prev['const TRIPS']) {
    if (typeof t.lat === 'number') prevTripSites[lower(t.site)] = t;
  }

  console.log('Logging in…');
  const classesHtml = await login(email, password);
  console.log('Scraping…');

  const classes = scrapeClasses(classesHtml);
  const instructors = scrapeInstructors(
    await getHtml(`${BASE}/manage_instructors.php`),
    prevInstrByName
  );
  const trips = scrapeTrips(await getHtml(`${BASE}/manage_field_trips.php`));

  // --- sites, from the classes actually running ---
  const siteMap = {};
  for (const c of classes) {
    if (!siteMap[c.siteKey]) {
      siteMap[c.siteKey] = {
        name: c.site, state: c.state, region: c.region, city: c.city, classes: [],
      };
    }
    siteMap[c.siteKey].classes.push(c);
  }

  const needAddress = Object.keys(siteMap).filter((k) => {
    const s = siteMap[k];
    const hit = prevSites[lower(s.name)] || prevSites[lower(String(s.name).split(' | ')[0])];
    if (hit) { Object.assign(s, { lat: hit.lat, lon: hit.lon, address: hit.address, zip: hit.zip }); return false; }
    return true;
  });

  if (needAddress.length) {
    console.log(`  ${needAddress.length} new site(s) need an address + geocode`);
    const ids = scrapeSchoolIds(await getHtml(`${BASE}/manage_schools.php`));
    for (const key of needAddress) {
      const s = siteMap[key];
      const base = lower(String(s.name).split(' | ')[0]);
      const id = ids[lower(s.name)] || ids[base] || ids[key];
      if (!id) { console.warn(`  ! no site record for "${s.name}"`); continue; }
      const addr = await fetchSchoolAddress(id);
      await sleep(300);
      const geo = await geocodeAddress(addr, s.state);
      if (geo) {
        Object.assign(s, { address: addr.address, zip: addr.zip, lat: geo.lat, lon: geo.lon });
        console.log(`  + ${s.name} → ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
      } else {
        console.warn(`  ! could not geocode "${s.name}"`);
      }
    }
  }

  const DATA = [];
  let id = 1, dropped = 0;
  for (const key of Object.keys(siteMap)) {
    const s = siteMap[key];
    if (typeof s.lat !== 'number' || Number.isNaN(s.lat)) { dropped++; continue; }
    DATA.push({
      id: id++, name: s.name, state: s.state, region: s.region, city: s.city,
      address: s.address || '', zip: s.zip || '', lat: s.lat, lon: s.lon,
      classes: s.classes.map((c) => ({
        program: c.program, course: c.course, instructor: c.instructor, status: c.status,
        startDate: c.startDate, endDate: c.endDate, sessions: c.sessions,
        sessionDates: c.sessionDates, time: c.time, day: c.day, miles: c.miles, psm: c.psm,
      })),
    });
  }
  if (dropped) console.warn(`  ! ${dropped} site(s) dropped for missing coordinates`);

  // --- instructor coordinates by ZIP ---
  const newZips = [...new Set(
    instructors.map((i) => i.zip).filter((z) => z && !prevZips[z])
  )];
  if (newZips.length) console.log(`  geocoding ${newZips.length} new ZIP(s)`);
  for (const z of newZips) {
    const hit = await nominatim(`postalcode=${encodeURIComponent(z)}`);
    await sleep(1100);
    if (hit) prevZips[z] = [hit.lat, hit.lon];
  }
  let unplaced = 0;
  for (const i of instructors) {
    const g = prevZips[i.zip];
    if (g) { i.lat = g[0]; i.lon = g[1]; } else { unplaced++; }
  }
  if (unplaced) console.warn(`  ! ${unplaced} instructor(s) have no mappable ZIP`);

  for (const t of trips) {
    const g = prevTripSites[t.siteKey];
    if (g) { t.lat = g.lat; t.lon = g.lon; t.address = g.address; t.zip = g.zip; }
  }

  // --- sanity gates: never publish an obviously broken build ---
  const totalClasses = DATA.reduce((n, s) => n + s.classes.length, 0);
  const prevClasses = prev['const DATA'].reduce((n, s) => n + (s.classes || []).length, 0);
  if (!DATA.length) throw new Error('Refusing to publish: zero sites.');
  if (prevClasses && totalClasses < prevClasses * 0.5) {
    throw new Error(
      `Refusing to publish: class count collapsed ${prevClasses} → ${totalClasses}. ` +
      `Likely a layout change or a partial page. Check the sandbox.`
    );
  }
  for (const st of ['FL', 'TX', 'GA']) {
    if (!instructors.some((i) => i.state === st)) {
      throw new Error(`Refusing to publish: zero ${st} instructors (this has been a real bug before).`);
    }
  }

  // --- splice and verify ---
  html = spliceArray(html, 'const DATA', JSON.stringify(DATA));
  html = spliceArray(html, 'const INSTRUCTORS', JSON.stringify(instructors));
  html = spliceArray(html, 'const TRIPS', JSON.stringify(trips));

  const stamp = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Chicago',
  });
  const time = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  });
  html = html.replace(
    /el\('stamp'\)\.innerHTML='Sandbox sync: [^']*'/,
    `el('stamp').innerHTML='Sandbox sync: ${stamp}, ${time} CT · FL / TX / GA'`
  );

  // The data block must still parse as JavaScript.
  const dataStart = html.indexOf('const DATA');
  const dataEnd = html.indexOf('</script>', dataStart);
  // eslint-disable-next-line no-new-func
  new Function(html.slice(dataStart, dataEnd));

  fs.writeFileSync(INDEX, html);
  console.log(
    `\nDone: ${DATA.length} sites · ${totalClasses} classes ` +
    `(${DATA.reduce((n, s) => n + s.classes.filter((c) => c.status === 'filled').length, 0)} staffed) · ` +
    `${instructors.length} instructors · ${trips.length} field trips`
  );
}

main().catch((err) => {
  console.error(`\nSync failed: ${err.message}`);
  process.exit(1);
});
