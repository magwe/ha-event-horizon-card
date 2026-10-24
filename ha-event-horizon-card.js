/*
 * family-timeline-card + family-action-card
 * Läser kalendrar direkt via HA:s REST-API (/api/calendars/<entity>) – inga hjälpsensorer behövs.
 *  - custom:family-timeline-card  – dagens tidslinje per person
 *  - custom:family-action-card    – det som är agerbart: stor nedräkning + stora förberedelse-ikoner
 */
const FTC_VERSION = '0.18.0';

const TRAVEL_MODEL = { road_factor: 1.3, walk_kmh: 5, bike_kmh: 15, car_kmh: 40, car_extra: 5, max_walk: 15, max_bike: 15 };
const BASE_DEFAULTS = {
  refresh_minutes: 10,
  samling: true,
  font_scale: 1,
  rules: [],
  places: [],
  geocode: false,
  default_travel: 10,
  default_prepare: 10,
  default_mode: 'walk',
  day_before_from: '12:00',
};
const MODE_ICON = { walk: 'mdi:walk', bike: 'mdi:bike', car: 'mdi:car', carpool: 'mdi:car-multiple', bus: 'mdi:bus' };
const MODE_VERB = { walk: 'Gå', bike: 'Cykla', car: 'Åk', carpool: 'Åk', bus: 'Åk' };
const SEV = { green: 'var(--success-color, #43a047)', yellow: 'var(--warning-color, #ffa000)', red: 'var(--error-color, #e53935)', blue: 'var(--info-color, #039be5)' };
const GRAY = 'var(--secondary-text-color, #9e9e9e)';
/* Fas → färg. 'onsite' = förberedelsetid på plats (mellan samling och start). */
const PHASE_COLOR = { green: SEV.green, yellow: SEV.yellow, red: SEV.red, onsite: SEV.yellow };

const esc = (s) => String(pick(s, '')).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d, add = 0) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + add); return x; };
const atTime = (day, hhmm) => { const [h, m] = String(hhmm || '00:00').split(':').map(Number); const x = new Date(day); x.setHours(h || 0, m || 0, 0, 0); return x; };
const re = (s) => (s ? new RegExp(s, 'i') : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Första värdet som inte är undefined/null (ersätter ?? för äldre Chromecast/WebView). */
const pick = (...v) => { for (const x of v) if (x !== undefined && x !== null) return x; return undefined; };

function parseWhen(w) {
  if (!w) return null;
  if (typeof w === 'string') w = w.length === 10 ? { date: w } : { dateTime: w };
  if (w.dateTime) return { d: new Date(w.dateTime), allDay: false };
  const [y, m, d] = w.date.split('-').map(Number);
  return { d: new Date(y, m - 1, d), allDay: true };
}

function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m <= 0) return 'nu';
  if (m < 60) return `om ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `om ${h} h ${r} min` : `om ${h} h`;
}

const compileRules = (list) => (list || []).map((r) => ({ ...r, _re: re(r.match) }));

/*
 * Nedräkningsring mot aktivitetens starttid. Full ring = 60 min när högst 60 min återstår, annars 12 h (720 min).
 * Räknat bakåt från start: gul förberedelse på plats (start − samling), röd restid, gul förberedelse hemma,
 * därefter ledig tid: grön på 60-minutersskalan, blå på 12-timmarsskalan (så att skalan syns direkt).
 * Ringen ligger som på en urtavla: värdet 0 (målet) ligger där minutvisaren (60-minutersskalan) eller
 * timvisaren (12-timmarsskalan) står vid måltiden, så nedräkningens bakkant följer visaren på en riktig klocka.
 * Passerad tid tonas bort.
 */
function countdownRing(it, rem, ongoing, target) {
  const scale = rem <= 60 ? 60 : 720;
  const tg = target || new Date(Date.now() + rem * 60000);
  const clockMin = scale === 60
    ? tg.getMinutes() + tg.getSeconds() / 60
    : (tg.getHours() % 12) * 60 + tg.getMinutes() + tg.getSeconds() / 60;
  const a0 = (clockMin / scale) * 2 * Math.PI; // målets vinkel medurs från kl. 12
  const O = it.onsite || 0, OT = O + (it.travel || 0), S = OT + (it.prepare || 0);
  const R = 43, cx = 50, cy = 50;
  const f = (n) => n.toFixed(2);
  const pt = (v) => { const a = a0 - (v / scale) * 2 * Math.PI; return [cx + R * Math.sin(a), cy - R * Math.cos(a)]; };
  const arc = (v1, v2, col, op) => {
    if (v2 - v1 <= 0.01) return '';
    if (v2 - v1 >= scale) v2 = v1 + scale - 0.01;
    const [x1, y1] = pt(v1), [x2, y2] = pt(v2);
    const large = (v2 - v1) / scale > 0.5 ? 1 : 0;
    return `<path d="M${f(x1)} ${f(y1)} A${R} ${R} 0 ${large} 0 ${f(x2)} ${f(y2)}" stroke="${col}" stroke-opacity="${op}" />`;
  };
  // Pågående aktivitet: gråskala mot sluttiden, men restiden (t.ex. för hämtning) behålls som röd markering.
  const segs = ongoing
    ? [[0, it.travel || 0, SEV.red], [it.travel || 0, scale, GRAY]]
    : [[0, O, SEV.yellow], [O, OT, SEV.red], [OT, S, SEV.yellow], [S, scale, scale === 60 ? SEV.green : SEV.blue]];
  let out = '';
  for (const seg of segs) {
    const a = seg[0], b = Math.min(seg[1], scale), col = seg[2];
    if (b <= a) continue;
    out += arc(a, Math.min(b, rem), col, 1);
    out += arc(Math.max(a, rem), b, col, 0.13);
  }
  return `<svg class="cring" viewBox="0 0 100 100">${out}</svg>`;
}

/* ---------- Restid från plats (valfri geokodning via OpenStreetMap Nominatim, cachas i webbläsaren) ---------- */
const GEO_MEM = new Map();
const GEO_PENDING = new Map();
let geoBusy = false;

function haversineKm(a, b) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function travelFromKm(km, m) {
  const road = km * m.road_factor;
  const walk = (road / m.walk_kmh) * 60;
  if (walk <= m.max_walk) return { travel: Math.max(5, Math.ceil(walk)), mode: 'walk' };
  const bike = (road / m.bike_kmh) * 60;
  if (bike <= m.max_bike) return { travel: Math.ceil(bike) + 2, mode: 'bike' };
  return { travel: Math.ceil((road / m.car_kmh) * 60 + m.car_extra), mode: 'car' };
}

function geoCandidates(loc) {
  const s = loc.replace(/\s+/g, ' ').trim();
  const out = [s];
  const par = /\(([^)]+)\)/.exec(s);
  if (par) out.push(par[1]);
  const noPar = s.replace(/\([^)]*\)/g, '').trim();
  out.push(noPar, noPar.split(',')[0].trim());
  return [...new Set(out)].filter(Boolean);
}

function geoEnqueue(loc, key, cb) {
  if (GEO_PENDING.has(key)) { GEO_PENDING.get(key).cbs.add(cb); return; }
  GEO_PENDING.set(key, { loc, cbs: new Set([cb]) });
  geoPump();
}

async function geoPump() {
  if (geoBusy) return;
  geoBusy = true;
  try {
    for (const [key, job] of GEO_PENDING) {
      let hit = null;
      for (const q of geoCandidates(job.loc)) {
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=se&q=${encodeURIComponent(q)}`);
          const j = await r.json();
          if (j && j[0]) hit = { lat: Number(j[0].lat), lon: Number(j[0].lon) };
        } catch (e) { hit = undefined; }
        await sleep(1100); // Nominatims policy: max 1 anrop/sekund
        if (hit !== null) break;
      }
      GEO_PENDING.delete(key);
      if (hit !== undefined) {
        GEO_MEM.set(key, hit);
        try { localStorage.setItem(key, JSON.stringify(hit)); } catch (e) { /* ignore */ }
      } else {
        GEO_MEM.set(key, null); // nätverksfel: försök igen nästa sidladdning
      }
      job.cbs.forEach((cb) => { try { cb(); } catch (e) { /* ignore */ } });
    }
  } finally {
    geoBusy = false;
    if (GEO_PENDING.size) geoPump();
  }
}

/* ---------- Gemensam bas: konfig, hämtning, regler, sammanslagning ---------- */
class FamilyCalendarBase extends HTMLElement {
  static defaults() { return BASE_DEFAULTS; }

  setConfig(config) {
    if (config && !config.people && Array.isArray(config.sources)) {
      // Kortform: ett kort = en person (name/color/sources direkt på kortet)
      config = Object.assign({}, config, { people: [{
        name: config.name || '', color: config.color, sources: config.sources,
        travel: config.travel, mode: config.mode, prepare: config.prepare, countdown: config.countdown,
      }] });
    }
    if (!config || !Array.isArray(config.people) || !config.people.length) {
      throw new Error('Ange "sources" (en person) eller "people" (flera personer)');
    }
    const d = this.constructor.defaults();
    const c = {
      ...d, ...config,
      severity: { ...(d.severity || {}), ...(config.severity || {}) },
      travel_model: { ...TRAVEL_MODEL, ...(config.travel_model || {}) },
    };
    c.people = config.people.map((p) => ({
      ...p,
      sources: (p.sources || []).map((s) => ({
        ...s, _inc: re(s.include), _exc: re(s.exclude), _strip: re(s.strip), _rules: compileRules(s.rules),
      })),
    }));
    c._places = (c.places || []).map((p) => ({ ...p, _re: re(p.match) }));
    this._rules = compileRules(c.rules);
    this._config = c;
    this._events = this._events || null;
    this._lastFetch = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._render();
    if (this._hass) this._fetch();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._fetch();
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (!this._config) return;
      const stale = Date.now() - this._lastFetch > this._config.refresh_minutes * 60000;
      const newDay = this._fetchDay !== dayStart(new Date()).getTime();
      if (this._hass && (stale || newDay)) this._fetch();
      else this._render();
    }, 30000);
  }

  disconnectedCallback() { clearInterval(this._timer); }

  async _fetch() {
    if (this._fetching || !this._hass || !this._config) return;
    this._fetching = true;
    const now = new Date();
    const [from, to] = this._range(now);
    const cals = [...new Set(this._config.people.flatMap((p) => p.sources.map((s) => s.calendar)))];
    const out = {};
    await Promise.all(cals.map(async (cal) => {
      try {
        const res = await this._hass.callApi('GET',
          `calendars/${cal}?start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`);
        out[cal] = (res || []).map((e) => {
          const s = parseWhen(e.start), en = parseWhen(e.end) || s;
          return {
            summary: e.summary || '', description: e.description || '', location: e.location || '',
            start: s.d, end: en.d, allDay: s.allDay, calendar: cal,
          };
        });
      } catch (err) {
        console.warn('family-cards: kunde inte läsa', cal, err);
        out[cal] = (this._events && this._events[cal]) || [];
      }
    }));
    this._events = out;
    this._lastFetch = Date.now();
    this._fetchDay = dayStart(now).getTime();
    this._fetching = false;
    this._render();
  }

  /* Antal dagar till datumet i en påminnelsesensor (YYYY-MM-DD), eller null. */
  _reminderDays(r, now) {
    const st = this._hass && this._hass.states && this._hass.states[r.entity];
    if (!st) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(st.state);
    if (!m) return null;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Math.round((day - dayStart(now)) / 86400000);
  }

  /*
   * Färg/dölj för en påminnelse utifrån status_entity (house=röd, missing=gul, street=grön, empty=dölj)
   * eller presence_entity (BLE-tracker). Gemensam för agera-kortet och tidslinjen.
   */
  _reminderStatus(r, days, isDim, now) {
    let iconColor = null, hide = false;
    if (r.status_entity) {
      const ss = this._hass.states[r.status_entity];
      const state = ss ? ss.state : null;
      const colors = Object.assign({ house: 'red', missing: 'yellow', street: 'green' }, r.status_colors || {});
      const hideStates = [].concat(pick(r.status_hide, ['empty']));
      if (state && hideStates.indexOf(state) >= 0) hide = true;
      else if (state && colors[state]) {
        const col = colors[state];
        // nedtonade dagar: visa inte rött (det är inte dags att ställa ut än)
        if (!(isDim && col === 'red')) iconColor = SEV[col] || col;
      }
    } else if (r.presence_entity) {
      const ps = this._hass.states[r.presence_entity];
      if (ps) {
        const homeStates = [].concat(pick(r.home_state, 'home'));
        const atHouse = homeStates.indexOf(ps.state) >= 0;
        const recentlyBack = (now - new Date(ps.last_changed)) < pick(r.returned_hours, 24) * 3600000;
        if (!atHouse) iconColor = SEV.green;
        else if (days === 0 && recentlyBack) hide = true; // har varit vid gatan och kommit tillbaka
        else if (!isDim) iconColor = SEV.red;
      }
    }
    return { iconColor, hide };
  }

  /* Tidsintervall som hämtas från kalendrarna. */
  _range(now) { return [dayStart(now), dayStart(now, 2)]; }

  _home() {
    const z = this._hass && this._hass.states && this._hass.states['zone.home'];
    if (z && z.attributes && z.attributes.latitude != null) return { lat: z.attributes.latitude, lon: z.attributes.longitude };
    const cfg = this._hass && this._hass.config;
    return cfg && cfg.latitude != null ? { lat: cfg.latitude, lon: cfg.longitude } : null;
  }

  _geoLookup(loc) {
    const key = 'ftc-geo:' + loc.toLowerCase().replace(/\s+/g, ' ').trim();
    if (GEO_MEM.has(key)) return GEO_MEM.get(key);
    try {
      const s = localStorage.getItem(key);
      if (s !== null) { const v = JSON.parse(s); GEO_MEM.set(key, v); return v; }
    } catch (e) { /* ignore */ }
    geoEnqueue(loc, key, () => this._render());
    return undefined;
  }

  /* Prioritet: regel > plats-tabell > geokodad plats > källa > person > standard */
  _travel(e, src, rule, person) {
    const c = this._config;
    const fallbackMode = rule.mode || src.mode || person.mode || c.default_mode;
    if (rule.travel != null) return { travel: rule.travel, mode: fallbackMode };
    if (e.location) {
      const pl = c._places.find((p) => p._re && p._re.test(e.location));
      if (pl) return { travel: pl.travel, mode: pl.mode || fallbackMode };
      if (c.geocode) {
        const home = this._home();
        const g = this._geoLookup(e.location);
        if (g && home) return travelFromKm(haversineKm(home, g), c.travel_model);
      }
    }
    return { travel: pick(src.travel, person.travel, c.default_travel), mode: fallbackMode };
  }

  _decorate(e, src, person) {
    const rule = [...src._rules, ...this._rules].find((r) => r._re && (r._re.test(e.summary) || (r.match_description && r._re.test(e.description)))) || {};
    let clean = e.summary;
    if (src._strip) clean = clean.replace(src._strip, '').trim();
    let meet = null;
    if (this._config.samling && !e.allDay) {
      const m = /Samling:?\s*(?:kl\.?\s*)?(\d{1,2})[:.](\d{2})/i.exec(e.description);
      if (m) {
        meet = new Date(e.start); meet.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (meet > e.start) meet = null;
      }
    }
    const tr = e.allDay ? { travel: 0, mode: null } : this._travel(e, src, rule, person);
    const onsite = meet ? (e.start - meet) / 60000 : pick(rule.onsite, src.onsite, person.onsite, 0);
    // Övernattning: heldag över mer än ett dygn, eller tidsatt händelse som slutar en senare dag.
    const overnight = e.allDay ? (e.end - e.start) > 86400000 + 3600000 : dayStart(e.end) > dayStart(e.start) && +e.end !== +dayStart(e.end);
    const baseIcon = rule.icon || src.icon || 'mdi:calendar';
    const icon = overnight ? (rule.icon_overnight || src.icon_overnight || baseIcon) : baseIcon;
    return {
      ...e,
      clean,
      title: rule.label || src.label || clean || e.summary,
      icon,
      overnight,
      ruleIcon: rule.icon || null,
      textLabel: !!src.text_labels,
      badge: rule.badge !== false, // badge: false = ämnesikon som inte ska visas som liten symbol på skolblocket
      color: rule.color || src.color || null,
      hide: !!rule.hide,
      separate: !!rule.separate,
      move_to: rule.move_to || null,
      meet,
      onsite,
      travel: tr.travel,
      mode: tr.mode,
      prepare: pick(rule.prepare, src.prepare, person.prepare, this._config.default_prepare),
      countdown: pick(rule.countdown, src.countdown, true),
      notice: pick(rule.notice, src.notice, e.allDay ? 'none' : 'same_day'),
      ruleNotice: rule.notice || 'none',
      notice_text: rule.notice_text || src.notice_text || null,
      notice_icon: rule.notice_icon || src.notice_icon || null,
      notice_until: rule.notice_until || src.notice_until || null,
      notice_days: pick(rule.notice_days, src.notice_days, null), // påminnelse N dagar i förväg (agera-kortet)
    };
  }

  _buildDay(d0) {
    const d1 = dayStart(d0, 1);
    const c = this._config;
    const rows = c.people.map((p) => ({ person: p, items: [] }));
    const byName = {};
    rows.forEach((r) => { byName[r.person.name] = r; });
    for (const row of rows) {
      const person = row.person;
      for (const src of person.sources) {
        let evs = ((this._events && this._events[src.calendar]) || []).filter((e) => e.start < d1 && e.end > d0);
        if (src._inc) evs = evs.filter((e) => src._inc.test(e.summary));
        if (src._exc) evs = evs.filter((e) => !src._exc.test(e.summary));
        const all = evs.map((e) => this._decorate(e, src, person));
        const dec = all.filter((x) => !x.hide);
        let items = dec;
        if (src.merge) {
          // Dolda händelser (t.ex. Rast) räknas ändå in i skoldagens längd vid sammanslagning.
          items = dec.filter((x) => x.allDay || x.separate);
          const gap = pick(src.merge_gap, 180) * 60000;
          let cur = null;
          for (const x of all.filter((x) => !x.allDay && !x.separate).sort((a, b) => a.start - b.start)) {
            if (cur && x.start - cur.end <= gap) {
              if (x.end > cur.end) cur.end = x.end;
              cur.children.push(x);
            } else {
              cur = {
                title: src.label || 'Skola', icon: src.icon || 'mdi:school', color: src.color || null,
                start: x.start, end: x.end, allDay: false, merged: true, children: [x], clean: '', meet: null,
                onsite: pick(src.onsite, person.onsite, 0),
                travel: pick(src.travel, person.travel, c.default_travel),
                mode: src.mode || person.mode || c.default_mode,
                prepare: pick(src.prepare, person.prepare, c.default_prepare),
                countdown: pick(src.countdown, true),
                notice: 'none',
                late_start_after: src.late_start_after || null,
              };
              items.push(cur);
            }
          }
          const mergedBlocks = items.filter((i) => i.merged);
          if (mergedBlocks.length) mergedBlocks[0].firstOfDay = true;
          for (const b of mergedBlocks) {
            const vis = b.children.filter((ch) => !ch.hide);
            b.firstLesson = vis.length ? vis[0].clean : '';
            b.firstIcon = vis.length ? vis[0].ruleIcon : null; // första lektionens ämnesikon
            b.badges = [...new Set(vis.filter((ch) => ch.badge).map((ch) => ch.ruleIcon).filter(Boolean))];
            b.clean = vis.map((ch) => ch.clean).join(', ');
          }
        }
        if (src.countdown === 'first') {
          // Bara dagens första händelse från källan räknas ner (t.ex. första lektionen)
          items.filter((x) => !x.allDay).sort((a, b) => a.start - b.start)
            .forEach((x, i) => { x.countdown = i === 0; });
        }
        for (const it of items) ((it.move_to && byName[it.move_to]) || row).items.push(it);
      }
    }
    rows.forEach((r) => r.items.sort((a, b) => a.start - b.start));
    return rows;
  }

  /* Faser bakåt från start: på plats (samling→start), restid (röd), förberedelse hemma (gul), fritid (grön). */
  _phase(item, start, now) {
    const meet = new Date(start - (item.onsite || 0) * 60000);
    const leave = new Date(meet - item.travel * 60000);
    const prep = new Date(leave - item.prepare * 60000);
    const phase = now >= meet ? 'onsite' : now >= leave ? 'red' : now >= prep ? 'yellow' : 'green';
    return { meet, leave, prep, phase };
  }

  /*
   * Vad nedräkningen ska visa: en pågående aktivitet (mot dess slut) så länge nästa aktivitet
   * fortfarande är i grön fas; annars nästa aktivitet (mot dess start).
   */
  _focus(items, now) {
    const next = this._nextTimed(items, now);
    const ongoing = items
      .filter((i) => !i.allDay && i.countdown !== false && i.start <= now && i.end > now)
      .sort((a, b) => a.end - b.end)[0] || null;
    if (ongoing && (!next || this._phase(next.i, next.t, now).phase === 'green')) {
      return { ongoing: true, i: ongoing, t: ongoing.end };
    }
    return next;
  }

  /* Nästa aktivitet; nedräkningen går alltid mot kalenderns starttid. */
  _nextTimed(items, now) {
    return items
      .filter((i) => !i.allDay && i.countdown !== false && i.start > now)
      .map((i) => ({ i, t: i.start }))
      .sort((a, b) => a.t - b.t)[0] || null;
  }
}

/* ======================= Tidslinje ======================= */
class FamilyTimelineCard extends FamilyCalendarBase {
  static defaults() {
    return { ...BASE_DEFAULTS, start_hour: 7, end_hour: 21, countdown_window: 60, show_tomorrow: true };
  }
  getCardSize() { return 2 + this._config.people.length * 2; }
  getGridOptions() { return { columns: 'full', min_columns: 9 }; }
  static getStubConfig() {
    return { people: [{ name: 'Namn', color: 'tomato', sources: [{ calendar: 'calendar.familj' }] }] };
  }

  _renderNext(items, tomorrowItems, now, color) {
    const timed = items.filter((i) => !i.allDay);
    const current = timed.find((i) => i.start <= now && i.end > now);
    const next = this._focus(items, now);
    const curHtml = current && !(next && next.ongoing) ? `<div class="ncur">Nu: ${esc(current.title)} till ${hm(current.end)}</div>` : '';

    if (!next) {
      const tm = tomorrowItems.filter((i) => !i.allDay)[0];
      return `<div class="next"><div class="ring idle"><ha-icon icon="mdi:check"></ha-icon></div>
        <div class="ntext">${curHtml || '<div class="nsub">Inget mer idag</div>'}
        ${tm ? `<div class="nsub">I morgon ${hm(tm.start)} ${esc(tm.title)}</div>` : ''}</div></div>`;
    }

    const leftMs = next.t - now;
    const leftMin = leftMs / 60000;
    if (next.ongoing) {
      const pickRed = leftMin <= (next.i.travel || 0);
      return `<div class="next">
      <div class="ring ongoing" title="${esc(next.i.clean || next.i.title)}">
        ${countdownRing(next.i, leftMin, true, next.t)}
        <div class="lbl"><ha-icon icon="${esc(next.i.icon)}"></ha-icon></div>
      </div>
      <div class="ntext">
        <div class="ntitle"><ha-icon icon="${esc(next.i.icon)}"></ha-icon><span>${esc(next.i.title)}</span></div>
        <div class="nsub">Pågår till ${hm(next.t)} · <b style="color:${pickRed ? SEV.red : 'inherit'}">${fmtLeft(leftMs)}</b></div>
      </div></div>`;
    }
    const ph = this._phase(next.i, next.t, now);
    const inWindow = leftMin <= 60 || ph.phase !== 'green';
    const ringColor = PHASE_COLOR[ph.phase];
    const when = next.i.meet ? `${hm(next.t)} · samling ${hm(next.i.meet)}` : hm(next.t);
    return `<div class="next">
      <div class="ring" title="${esc(next.i.clean || next.i.title)}">
        ${countdownRing(next.i, leftMin, false, next.t)}
        <div class="lbl"><ha-icon icon="${esc(next.i.icon)}"></ha-icon></div>
      </div>
      <div class="ntext">
        <div class="ntitle"><ha-icon icon="${esc(next.i.icon)}"></ha-icon><span>${esc(next.i.title)}</span></div>
        <div class="nsub">${when} · <b style="color:${inWindow ? ringColor : 'inherit'}">${fmtLeft(leftMs)}</b></div>
        ${curHtml}
      </div></div>`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const now = new Date();
    const vs = dayStart(now); vs.setHours(c.start_hour);
    const ve = dayStart(now); ve.setHours(c.end_hour);
    const span = ve - vs;
    const pct = (d) => Math.max(0, Math.min(100, ((d - vs) / span) * 100));

    let body = '';
    if (!this._events) {
      body = '<div class="loading">Hämtar kalendrar…</div>';
    } else {
      const today = this._buildDay(dayStart(now));
      const tomorrow = c.show_tomorrow ? this._buildDay(dayStart(now, 1)) : null;

      let ticks = '';
      for (let h = c.start_hour; h <= c.end_hour; h++) {
        const d = dayStart(now); d.setHours(h);
        if ((h - c.start_hour) % (c.tick_hours || 2) === 0) ticks += `<span class="tick" style="left:${pct(d)}%">${pad(h)}</span>`;
      }
      let gridlines = '';
      for (let h = c.start_hour + 1; h < c.end_hour; h++) {
        const d = dayStart(now); d.setHours(h);
        gridlines += `<div class="gl" style="left:${pct(d)}%"></div>`;
      }
      const nowPct = now >= vs && now <= ve ? pct(now) : null;

      body += `<div class="hdr"></div><div class="axis">${ticks}</div><div class="hdr nexth">Nästa</div>`;

      today.forEach((row, idx) => {
        const p = row.person;
        const color = p.color || 'var(--primary-color)';
        const allDay = row.items.filter((i) => i.allDay);
        const timed = row.items.filter((i) => !i.allDay && i.end > vs && i.start < ve);
        const lanes = [];
        for (const it of timed) {
          let l = lanes.findIndex((end) => end <= it.start);
          if (l < 0) { l = lanes.length; lanes.push(it.end); } else lanes[l] = it.end;
          it.lane = l;
        }
        const nLanes = Math.max(1, lanes.length);
        // påminnelser från sensorer (t.ex. sophämtning): idag som etikett, i morgon på morgondagsraden
        const remToday = [], remTomorrow = [];
        for (const r of (p.entity_reminders || [])) {
          const days = this._reminderDays(r, now);
          if (days !== 0 && days !== 1) continue;
          const stt = this._reminderStatus(r, days, false, now);
          if (stt.hide) continue;
          const st = this._hass.states[r.entity];
          const rem = { icon: r.icon || 'mdi:delete', title: r.name || (st.attributes && st.attributes.friendly_name) || r.entity, iconColor: stt.iconColor };
          (days === 0 ? remToday : remTomorrow).push(rem);
        }
        const chips = allDay.map((i) => `<span class="chip" style="--c:${i.color || color}"><ha-icon icon="${esc(i.icon)}"></ha-icon>${esc(i.title)}</span>`).join('')
          + remToday.map((i) => `<span class="chip" style="--c:${color}"><ha-icon icon="${esc(i.icon)}"${i.iconColor ? ` style="color:${i.iconColor}"` : ''}></ha-icon>${esc(i.title)}</span>`).join('');
        const blocks = timed.map((i) => {
          const l = pct(i.start), w = Math.max(0.8, pct(i.end) - l);
          const badges = (i.badges || []).map((b) => `<ha-icon class="badge" icon="${esc(b)}"></ha-icon>`).join('');
          const past = i.end <= now ? ' past' : '';
          const tip = `${hm(i.start)}–${hm(i.end)} ${i.clean || i.title}${i.location ? ' · ' + i.location : ''}`;
          return `<div class="blk${past}" title="${esc(tip)}" style="--c:${i.color || color};left:${l}%;width:${w}%;top:calc(${i.lane} * var(--lane-h))">
            <ha-icon icon="${esc(i.icon)}"></ha-icon>${badges}<span class="t">${esc(i.title)}</span><span class="tm">${hm(i.start)}</span></div>`;
        }).join('');
        let tmHtml = '';
        if (tomorrow) {
          const ti = tomorrow[idx].items;
          if (ti.length || remTomorrow.length) {
            tmHtml = `<div class="tomorrow"><span class="tl">I morgon:</span>${remTomorrow.map((i) =>
              `<span><ha-icon icon="${esc(i.icon)}"${i.iconColor ? ` style="color:${i.iconColor}"` : ''}></ha-icon>${esc(i.title)}</span>`).join('')}${ti.map((i) =>
              `<span><ha-icon icon="${esc(i.icon)}"></ha-icon>${i.allDay ? '' : hm(i.start) + ' '}${esc(i.title)}${(i.badges || []).map((b) => `<ha-icon icon="${esc(b)}"></ha-icon>`).join('')}</span>`).join('')}</div>`;
          }
        }
        body += `
          <div class="who" style="--c:${color}"><div class="name">${esc(p.name)}</div>${chips ? `<div class="chips">${chips}</div>` : ''}</div>
          <div class="trackwrap">
            <div class="track" style="height:calc(${nLanes} * var(--lane-h))">${gridlines}${blocks}${nowPct !== null ? `<div class="now" style="left:${nowPct}%"></div>` : ''}</div>
            ${tmHtml}
          </div>
          ${this._renderNext(row.items, tomorrow ? tomorrow[idx].items : [], now, color)}`;
      });
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; --fs:${Number(c.font_scale) || 1}; }
        ha-card { padding: 12px 16px 14px; font-size: calc(16px * var(--fs)); --lane-h: 2.3em; }
        .title { font-size:1.3em; font-weight:600; margin-bottom:6px; }
        .grid { display:grid; grid-template-columns: ${c.name_width || '7em'} minmax(0,1fr) ${c.next_width || '16em'}; column-gap:14px; row-gap:12px; align-items:start; }
        .axis { position:relative; height:1.3em; }
        .tick { position:absolute; transform:translateX(-50%); font-size:.75em; opacity:.6; }
        .nexth { font-size:.75em; opacity:.6; }
        .who { border-left:6px solid var(--c); padding-left:8px; min-height:var(--lane-h); }
        .name { font-weight:600; font-size:1.25em; line-height:var(--lane-h); }
        .chips { display:flex; flex-wrap:wrap; gap:4px; }
        .chip { display:inline-flex; align-items:center; gap:3px; font-size:.75em; padding:1px 7px 1px 4px; border-radius:999px; border:1px solid var(--c); }
        .chip ha-icon { --mdc-icon-size:1.25em; color:var(--c); }
        .track { position:relative; background:rgba(127,127,127,.10); border-radius:8px; }
        .gl { position:absolute; top:0; bottom:0; width:1px; background:rgba(127,127,127,.18); }
        .blk { position:absolute; height:calc(var(--lane-h) - 4px); margin-top:2px; border-radius:6px; overflow:hidden; isolation:isolate;
               display:flex; align-items:center; gap:4px; padding:0 6px; box-sizing:border-box; white-space:nowrap; font-size:.9em; border:1px solid var(--c); }
        .blk::before { content:''; position:absolute; top:0; left:0; right:0; bottom:0; background:var(--c); opacity:.30; z-index:-1; }
        .blk.past { opacity:.35; }
        .blk ha-icon { --mdc-icon-size:1.3em; flex:none; }
        .blk ha-icon.badge { --mdc-icon-size:1.1em; color:var(--c); filter:brightness(1.3); }
        .blk .t { overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:0; }
        .blk .tm { opacity:.75; font-size:.85em; flex:none; }
        .now { position:absolute; top:-3px; bottom:-3px; width:3px; margin-left:-1px; background:var(--error-color,#e53935); border-radius:2px; z-index:2; }
        .tomorrow { font-size:.78em; opacity:.75; margin-top:4px; display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; }
        .tomorrow ha-icon { --mdc-icon-size:1.2em; margin-right:2px; }
        .tomorrow .tl { font-weight:600; }
        .next { display:flex; align-items:center; gap:10px; min-height:var(--lane-h); }
        .ring { flex:none; width:3.6em; height:3.6em; position:relative; display:flex; align-items:center; justify-content:center; }
        .ring.idle { opacity:.5; }
        .ring.ongoing .lbl { opacity:.35; }
        .ring svg { position:absolute; top:0; left:0; right:0; bottom:0; width:100%; height:100%; }
        .cring path { fill:none; stroke-width:11; }
        .ring .lbl { position:relative; }
        .ring ha-icon { --mdc-icon-size:1.7em; }
        .ntext { min-width:0; }
        .ntitle { font-weight:600; display:flex; gap:6px; align-items:center; white-space:nowrap; overflow:hidden; }
        .ntitle span { overflow:hidden; text-overflow:ellipsis; }
        .ntitle ha-icon { --mdc-icon-size:1.2em; flex:none; }
        .nsub { font-size:.85em; opacity:.85; }
        .ncur { font-size:.78em; opacity:.65; }
        .loading { padding:1em; opacity:.6; }
      </style>
      <ha-card>
        ${c.title ? `<div class="title">${esc(c.title)}</div>` : ''}
        <div class="grid">${body}</div>
      </ha-card>`;
  }
}

/* ======================= Agera ======================= */
class FamilyActionCard extends FamilyCalendarBase {
  static defaults() { return { ...BASE_DEFAULTS, horizon: 720, font_scale: 1.2, lookahead_days: 1 }; }
  getCardSize() { return 8; }
  /* Hämta så långt fram som påminnelser med notice_days behöver (lookahead_days). */
  _range(now) { return [dayStart(now), dayStart(now, 1 + Math.max(1, this._config.lookahead_days || 1))]; }
  getGridOptions() { return { columns: 'full', min_columns: 9 }; }
  static getStubConfig() {
    return { people: [{ name: 'Namn', color: 'tomato', sources: [{ calendar: 'calendar.familj' }] }] };
  }

  _gauge(next, now) {
    const it = next.i;
    const ph = this._phase(it, next.t, now);
    const rem = (next.t - now) / 60000;
    const big = rem >= 60 ? `${Math.floor(rem / 60)}:${pad(Math.floor(rem % 60))}` : `${Math.ceil(rem)}`;
    const unit = rem >= 60 ? 'tim' : 'min';
    const verb = MODE_VERB[it.mode] || 'Gå';
    const msg = ph.phase === 'onsite' ? `På plats · start ${hm(next.t)}`
      : ph.phase === 'red' ? `${verb} nu!`
      : ph.phase === 'yellow' ? `Gör dig redo · ${verb.toLowerCase()} ${hm(ph.leave)}`
      : `${verb} senast ${hm(ph.leave)}`;
    const when = it.meet ? `${hm(next.t)} · samling ${hm(it.meet)}` : hm(next.t);
    const badges = (it.badges || []).map((b) => `<ha-icon class="badge" icon="${esc(b)}"></ha-icon>`).join('');
    const label = it.firstLesson ? `${it.title} · ${it.firstLesson}` : it.title;
    const timeColor = (rem <= 60 || ph.phase !== 'green') ? PHASE_COLOR[ph.phase] : 'inherit';
    const icon = it.firstIcon || it.icon;
    return `<div class="cd ${ph.phase}">
      <div class="bigring">
        ${countdownRing(it, rem, false, next.t)}
        <div class="lbl"><ha-icon icon="${esc(icon)}"></ha-icon></div>
      </div>
      <div class="big" style="color:${timeColor}">${big}<span class="unit">${unit}</span></div>
      <div class="what">${badges}<span>${esc(label)} ${when}</span></div>
      <div class="go" style="color:${timeColor}"><ha-icon icon="${esc(MODE_ICON[it.mode] || 'mdi:walk')}"></ha-icon><span>${msg}</span></div>
    </div>`;
  }

  /* Pågående aktivitet: släckt ikon, gråskala mot slutet, restiden markerad för hämtning. */
  _ongoing(cur, now) {
    const it = cur.i;
    const rem = (cur.t - now) / 60000;
    const big = rem >= 60 ? `${Math.floor(rem / 60)}:${pad(Math.floor(rem % 60))}` : `${Math.ceil(rem)}`;
    const unit = rem >= 60 ? 'tim' : 'min';
    const T = it.travel || 0;
    const pickup = new Date(cur.t - T * 60000);
    const red = now >= pickup;
    const label = it.firstLesson ? it.title : it.title;
    return `<div class="cd ongoing">
      <div class="bigring">
        ${countdownRing(it, rem, true, cur.t)}
        <div class="lbl"><ha-icon icon="${esc(it.icon)}"></ha-icon></div>
      </div>
      <div class="big">${big}<span class="unit">${unit}</span></div>
      <div class="what"><span>${esc(label)} pågår till ${hm(cur.t)}</span></div>
      <div class="go" style="color:${red ? SEV.red : 'inherit'}"><ha-icon icon="mdi:car-clock"></ha-icon><span>${red ? 'Dags att hämta' : `Hämtning: åk ${hm(pickup)}`}</span></div>
    </div>`;
  }

  /*
   * Påminnelser från sensorer vars tillstånd är ett datum (YYYY-MM-DD), t.ex. sophämtning.
   * active_days: dagar före (och på) dagen som påminnelsen är tänd. dim_days: dagar före som den visas nedsläckt.
   * presence_entity (valfri, t.ex. BLE-tracker på kärlet) med home_state = tillståndet "vid huset":
   *   vid huset sedan mer än 1 dygn  -> röd (behöver ställas ut)
   *   inte vid huset                 -> grön (antas stå vid gatan)
   *   vid huset sedan mindre än 1 dygn på hämtdagen -> tömt och tillbaka, påminnelsen tas bort
   * status_entity (valfri, sensor med färdig status): status_colors mappar tillstånd → färg
   *   (standard house=röd, missing=gul, street=grön) och status_hide listar tillstånd som döljer
   *   påminnelsen (standard empty). Övriga tillstånd (t.ex. unknown) ger neutral ikon.
   */
  _entityTiles(now) {
    const c = this._config, out = [];
    const t0 = dayStart(now);
    for (const r of (c.entity_reminders || [])) {
      const st = this._hass && this._hass.states && this._hass.states[r.entity];
      if (!st) continue;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(st.state);
      if (!m) continue;
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      const days = Math.round((day - t0) / 86400000);
      const active = pick(r.active_days, 1), dim = pick(r.dim_days, active);
      if (days < 0 || days > Math.max(active, dim)) continue;
      const isDim = days > active;
      const { iconColor, hide } = this._reminderStatus(r, days, isDim, now);
      if (hide) continue;
      const sub = days === 0 ? 'idag' : days === 1 ? 'i morgon' : `om ${days} dagar`;
      out.push({
        icon: r.icon || 'mdi:delete', text: r.name || (st.attributes && st.attributes.friendly_name) || r.entity,
        color: r.color || null, sub, dim: isDim, iconColor, isTomorrow: days >= 1, time: null, prio: 0, count: 1, days,
      });
    }
    return out.sort((a, b) => a.days - b.days);
  }

  _compact(next, now, isTomorrow) {
    const it = next.i;
    const ph = this._phase(it, next.t, now);
    const verb = (MODE_VERB[it.mode] || 'Gå').toLowerCase();
    return `<div class="cd compact">
      <div class="what"><ha-icon icon="${esc(it.firstIcon || it.icon)}"></ha-icon><span>${isTomorrow ? 'I morgon' : 'Nästa'}: ${esc(it.firstLesson ? it.title + ' · ' + it.firstLesson : it.title)} ${hm(next.t)}</span></div>
      <div class="go"><ha-icon icon="${esc(MODE_ICON[it.mode] || 'mdi:walk')}"></ha-icon><span>${verb} ${hm(ph.leave)}</span></div>
    </div>`;
  }

  _tiles(todayItems, tomorrowItems, now, skipItem, ahead) {
    const c = this._config;
    const t0 = dayStart(now);
    const dayBeforeOk = now >= atTime(t0, c.day_before_from);
    const tiles = new Map();
    const add = (icon, text, color, isTomorrow, time, sub, prio) => {
      const key = `${icon}|${text}|${isTomorrow}`;
      const t = tiles.get(key);
      if (t) { t.count++; if (time && (!t.time || time < t.time)) t.time = time; return; }
      tiles.set(key, { icon, text, color, isTomorrow, time, sub, prio, count: 1 });
    };
    const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
    const consider = (it, isTomorrow, parent) => {
      if (it === skipItem) return;
      if (!parent && it.notice_days != null) {
        // påminnelse N dagar i förväg: idag (fram till start), i morgon och dagarna därefter (se ahead)
        if (!isTomorrow && now >= (it.allDay ? atTime(t0, it.notice_until || '23:59') : (it.meet || it.start))) return;
        add(it.notice_icon || it.icon, it.notice_text || it.title, it.color, isTomorrow, it.allDay ? null : it.start, null, 1);
        return;
      }
      const n = parent ? it.ruleNotice : it.notice;
      if (!n || n === 'none') return;
      if (isTomorrow) {
        if (!((n === 'day_before' || n === 'both') && dayBeforeOk)) return;
      } else {
        if (!(n === 'same_day' || n === 'both')) return;
        const end = parent ? parent.start
          : !it.allDay ? (it.meet || it.start)
          : atTime(t0, it.notice_until || '23:59');
        if (now >= end) return;
      }
      const time = it.allDay || parent ? null : it.start;
      add(it.notice_icon || it.icon, it.notice_text || it.title, it.color, isTomorrow, time, null, isTomorrow ? 2 : 1);
    };
    const scan = (items, isTomorrow) => {
      for (const it of items) {
        if (it.merged) {
          it.children.filter((ch) => !ch.hide).forEach((ch) => consider(ch, isTomorrow, it));
          if (it.late_start_after && it.firstOfDay) {
            const late = it.start > atTime(dayStart(it.start), it.late_start_after);
            const show = isTomorrow ? dayBeforeOk : now < it.start;
            if (late && show) add('mdi:bed-clock', 'Sovmorgon', it.color, isTomorrow, null, `börjar ${hm(it.start)}`, 0);
          }
        } else consider(it, isTomorrow, null);
      }
    };
    scan(todayItems, false);
    scan(tomorrowItems, true);
    for (const a of (ahead || [])) {
      for (const it of a.items) {
        if (it.merged || it.notice_days == null || a.k > it.notice_days) continue;
        add(it.notice_icon || it.icon, it.notice_text || it.title, it.color, true, null,
          `${WD[it.start.getDay()]}${it.allDay ? '' : ' ' + hm(it.start)}`, 3);
      }
    }
    return [...tiles.values()].sort((a, b) => (a.isTomorrow - b.isTomorrow) || ((a.time || 0) - (b.time || 0)) || (a.prio - b.prio));
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const now = new Date();
    let body = '';
    if (!this._events) {
      body = '<div class="loading">Hämtar kalendrar…</div>';
    } else {
      const today = this._buildDay(dayStart(now));
      const tomorrow = this._buildDay(dayStart(now, 1));
      const aheadDays = [];
      for (let k = 2; k <= (c.lookahead_days || 1); k++) aheadDays.push({ k, rows: this._buildDay(dayStart(now, k)) });
      body = today.map((row, idx) => {
        const p = row.person;
        const color = p.color || 'var(--primary-color)';
        let cdHtml = '', skip = null;
        if (p.countdown !== false) {
          const next = this._focus(row.items, now);
          if (next && next.ongoing) { cdHtml = this._ongoing(next, now); skip = next.i; }
          else if (next && (next.t - now) / 60000 <= c.horizon) { cdHtml = this._gauge(next, now); skip = next.i; }
          else if (next) cdHtml = this._compact(next, now, false);
          else {
            const tm = this._nextTimed(tomorrow[idx].items, dayStart(now, 1));
            if (tm) cdHtml = this._compact(tm, now, true);
          }
        }
        const tiles = (idx === 0 ? this._entityTiles(now) : []).concat(this._tiles(row.items, tomorrow[idx].items, now, skip,
          aheadDays.map((a) => ({ k: a.k, items: a.rows[idx].items }))));
        const tilesHtml = tiles.length
          ? tiles.map((t) => {
            const when = t.sub || (t.isTomorrow ? `i morgon${t.time ? ' ' + hm(t.time) : ''}` : (t.time ? `idag ${hm(t.time)}` : 'idag'));
            return `<div class="tile${t.isTomorrow ? ' tm' : ''}${t.dim ? ' dim' : ''}" style="--c:${t.color || color}">
              <ha-icon icon="${esc(t.icon)}"${t.iconColor ? ` style="color:${t.iconColor}"` : ''}></ha-icon>
              <div class="tt">${esc(t.text)}${t.count > 1 ? ` <span class="cnt">×${t.count}</span>` : ''}</div>
              <div class="ts">${esc(when)}</div></div>`;
          }).join('')
          : (cdHtml ? '' : '<div class="none">Inget att förbereda</div>');
        return `<div class="col${c.layout === 'horizontal' ? ' h' : ''}" style="--c:${color}">
          ${p.name ? `<div class="hd">${esc(p.name)}</div>` : ''}
          ${cdHtml ? `<div class="cdwrap">${cdHtml}</div>` : ''}
          <div class="tiles">${tilesHtml}</div>
        </div>`;
      }).join('');
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; --fs:${Number(c.font_scale) || 1}; }
        ha-card { padding: 14px; font-size: calc(16px * var(--fs)); }
        .cols { display:grid; grid-template-columns: repeat(${c.people.length}, minmax(0,1fr)); grid-gap:14px; align-items:start; }
        .col { border-top:6px solid var(--c); border-radius:10px; background:rgba(127,127,127,.10); padding:10px 12px 12px; display:grid; grid-gap:10px; min-width:0; }
        .col.h { grid-template-columns: minmax(11em, 17em) minmax(0,1fr); align-items:center; }
        .col.h .hd { grid-column: 1 / -1; }
        .hd { font-size:1.5em; font-weight:700; }
        .cd { display:grid; justify-items:center; grid-gap:4px; }
        .bigring { position:relative; width:100%; max-width:11em; }
        .bigring svg { width:100%; display:block; }
        .cring path { fill:none; stroke-width:10; }
        .bigring .lbl { position:absolute; top:0; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; }
        .bigring .lbl ha-icon { --mdc-icon-size:4.2em; }
        .big { text-align:center; font-size:2.6em; font-weight:800; line-height:1; }
        .big .unit { font-size:.3em; font-weight:600; margin-left:.2em; opacity:.8; }
        .cd .what { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; font-size:1.1em; font-weight:600; margin-top:.6em; text-align:center; }
        .cd .what ha-icon { --mdc-icon-size:1.3em; margin-right:6px; }
        .cd .go { display:flex; align-items:center; font-size:1.15em; font-weight:700; }
        .cd .go ha-icon { --mdc-icon-size:1.5em; margin-right:6px; }
        .cd.red .go { animation: pulse 1.2s ease-in-out infinite; }
        .cd.ongoing .bigring .lbl { opacity:.3; }
        .cd.ongoing .big, .cd.ongoing .what { color:var(--secondary-text-color); }
        @keyframes pulse { 50% { opacity:.45; } }
        .cd.compact { justify-items:start; opacity:.85; }
        .cd.compact .what, .cd.compact .go { font-size:.95em; font-weight:600; margin:0; justify-content:flex-start; }
        .tiles { display:grid; grid-template-columns: repeat(auto-fill, minmax(6.5em, 1fr)); grid-gap:8px; }
        .tile { border:3px solid var(--c); border-radius:12px; padding:8px 6px; text-align:center; background:rgba(0,0,0,.18);
                display:flex; flex-direction:column; align-items:center; }
        .tile ha-icon { --mdc-icon-size:3.4em; color:var(--primary-text-color); margin-bottom:2px; }
        .tile .tt { font-weight:700; font-size:.95em; line-height:1.15; }
        .tile .cnt { opacity:.75; }
        .tile .ts { font-size:.8em; opacity:.8; }
        .tile.tm { border-style:dashed; }
        .tile.dim { opacity:.35; }
        .none { opacity:.5; font-size:.9em; }
        .loading { padding:1em; opacity:.6; }
      </style>
      <ha-card>
        ${c.title ? `<div class="hd">${esc(c.title)}</div>` : ''}
        <div class="cols">${body}</div>
      </ha-card>`;
  }
}

/* ======================= Solur ======================= */
/* Solens höjd (grader) för en tidpunkt och plats – förenklad astronomisk formel, ±0,5°. */
function sunElevation(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - 946728000000) / 86400000; // dagar sedan J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const alt = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return alt / rad;
}

/* Himmelsfärg utifrån solhöjd: natt → nautisk/borgerlig skymning → soluppgång → dag. */
const SKY_STOPS = [
  [-18, [8, 11, 26]], [-12, [14, 22, 52]], [-6, [44, 40, 92]], [-3, [120, 70, 110]],
  [0, [214, 120, 80]], [3, [236, 176, 104]], [8, [120, 170, 214]], [20, [78, 146, 210]],
];
function skyColor(elev) {
  if (elev <= SKY_STOPS[0][0]) return `rgb(${SKY_STOPS[0][1].join(',')})`;
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const [e1, c1] = SKY_STOPS[i - 1], [e2, c2] = SKY_STOPS[i];
    if (elev <= e2) {
      const k = (elev - e1) / (e2 - e1);
      return `rgb(${c1.map((v, j) => Math.round(v + (c2[j] - v) * k)).join(',')})`;
    }
  }
  return `rgb(${SKY_STOPS[SKY_STOPS.length - 1][1].join(',')})`;
}

class FamilySundialCard extends FamilyCalendarBase {
  static defaults() {
    return { ...BASE_DEFAULTS, wake: '07:00', back_hours: 6, height_offset: 16, sleep_color: '#5c6bc0', segment_gap: 0 };
  }
  getCardSize() { return 14; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() {
    return { people: [{ name: 'Namn', color: 'tomato', sleep: { hours: 9, prepare: 30 }, sources: [{ calendar: 'calendar.familj' }] }] };
  }
  _range(now) { return [dayStart(now, -1), dayStart(now, 2)]; }

  connectedCallback() {
    super.connectedCallback();
    if (!this._onResize) this._onResize = () => this._render();
    window.addEventListener('resize', this._onResize);
    setTimeout(() => this._render(), 50);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  }

  /* Sömn som aktivitet: slutar vid väckning, varar sleep.hours, med sleep.prepare minuters kvällsrutin före. */
  _sleepItems(person, now) {
    const s = person.sleep;
    if (!s) return [];
    const out = [];
    for (let k = -1; k <= 2; k++) {
      const wake = atTime(dayStart(now, k), s.wake || this._config.wake);
      out.push({
        title: 'Sömn', clean: 'Sömn', icon: s.icon || 'mdi:sleep', sleep: true, allDay: false,
        start: new Date(wake - pick(s.hours, 9) * 3600000), end: wake,
        travel: 0, onsite: 0, prepare: pick(s.prepare, 30), countdown: true, mode: null,
        color: s.color || this._config.sleep_color,
      });
    }
    return out;
  }

  _personItems(now) {
    const days = [dayStart(now, -1), dayStart(now), dayStart(now, 1)];
    const built = days.map((d) => this._buildDay(d));
    return this._config.people.map((p, idx) => {
      const seen = new Set();
      const items = [];
      built.forEach((rows) => rows[idx].items.forEach((it) => {
        if (it.allDay) return;
        const key = `${it.title}|${+it.start}|${+it.end}`;
        if (seen.has(key)) return; // händelser över midnatt finns i två dagar
        seen.add(key); items.push(it);
      }));
      return items.concat(this._sleepItems(p, now)).sort((a, b) => a.start - b.start);
    });
  }

  _nextText(items, now) {
    const f = this._focus(items, now);
    if (!f) return { text: 'Inget planerat', color: 'inherit' };
    const it = f.i;
    if (f.ongoing) {
      return { text: it.sleep ? `Sover till ${hm(f.t)}` : `${it.title} till ${hm(f.t)}`, color: GRAY, icon: it.icon };
    }
    const ph = this._phase(it, f.t, now);
    const label = it.firstLesson ? `${it.title} · ${it.firstLesson}` : it.title;
    if (it.sleep) {
      const msg = ph.phase === 'green' ? `Läggdags ${hm(f.t)}` : `Gör dig i ordning · sov ${hm(f.t)}`;
      return { text: msg, color: ph.phase === 'green' ? 'inherit' : PHASE_COLOR[ph.phase], icon: it.icon };
    }
    const verb = (MODE_VERB[it.mode] || 'Gå').toLowerCase();
    const tail = ph.phase === 'onsite' ? 'på plats' : ph.phase === 'red' ? `${verb} nu!` : `${verb} ${hm(ph.leave)}`;
    return { text: `${label} ${hm(f.t)} · ${tail}`, color: ph.phase === 'green' ? 'inherit' : PHASE_COLOR[ph.phase], icon: it.icon };
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const now = new Date();
    const width = this.clientWidth || (this.parentElement && this.parentElement.clientWidth) || window.innerWidth;
    const S = Math.max(240, Math.floor(Math.min(width, window.innerHeight - c.height_offset)));
    const ws = new Date(now - c.back_hours * 3600000), we = new Date(+ws + 24 * 3600000);

    // 24-timmarsurtavla: 00:00 nedåt, 12:00 uppåt, medurs (06 till vänster, 18 till höger).
    const ang = (t) => ((t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600 - 12) / 24) * 2 * Math.PI;
    const P = (r, a) => [500 + r * Math.sin(a), 500 - r * Math.cos(a)];
    const f2 = (n) => n.toFixed(1);
    const arcD = (r, t1, t2) => {
      let span = ((t2 - t1) / 86400000) * 2 * Math.PI;
      if (span <= 0.0005) return '';
      if (span >= 2 * Math.PI - 0.0005) span = 2 * Math.PI - 0.0005;
      const a1 = ang(t1), [x1, y1] = P(r, a1), [x2, y2] = P(r, a1 + span);
      return `M${f2(x1)} ${f2(y1)} A${r} ${r} 0 ${span > Math.PI ? 1 : 0} 1 ${f2(x2)} ${f2(y2)}`;
    };
    // Segment klippt till fönstret; passerad del tonas ner.
    const seg = (r, w, t1, t2, color, op) => {
      const a = new Date(Math.max(t1, ws)), b = new Date(Math.min(t2, we));
      if (b <= a) return '';
      let out = '';
      const pEnd = new Date(Math.min(b, now)), fStart = new Date(Math.max(a, now));
      if (pEnd > a) out += `<path d="${arcD(r, a, pEnd)}" stroke="${color}" stroke-width="${w}" stroke-opacity="${op * 0.35}" />`;
      if (b > fStart) out += `<path d="${arcD(r, fStart, b)}" stroke="${color}" stroke-width="${w}" stroke-opacity="${op}" />`;
      return out;
    };

    // Himmel
    const home = this._home() || { lat: 55.7, lon: 13.0 };
    let sky = '';
    const step = 10 * 60000;
    for (let t = +ws; t < +we; t += step) {
      const t1 = new Date(t), t2 = new Date(Math.min(t + step, +we));
      const a1 = ang(t1), a2 = a1 + ((t2 - t1) / 86400000) * 2 * Math.PI + 0.004;
      const [x1, y1] = P(495, a1), [x2, y2] = P(495, a2);
      sky += `<path d="M500 500 L${f2(x1)} ${f2(y1)} A495 495 0 0 1 ${f2(x2)} ${f2(y2)} Z" fill="${skyColor(sunElevation(new Date(t + step / 2), home.lat, home.lon))}" />`;
    }

    // Ringar: första personen ytterst
    const people = c.people;
    const ringW = pick(c.ring_width, Math.min(62, Math.floor(250 / Math.max(1, people.length)) - 10));
    const ringGap = pick(c.ring_gap, 10);
    const rOuter = 430;
    const items = this._events ? this._personItems(now) : people.map(() => []);
    let rings = '', icons = '', seps = '';
    people.forEach((p, idx) => {
      const r = rOuter - idx * (ringW + ringGap);
      const color = p.color || 'var(--primary-color)';
      rings += `<circle cx="500" cy="500" r="${r}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="${ringW}" />`;
      rings += `<circle cx="500" cy="500" r="${r + ringW / 2}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity=".7" />`;
      for (const it of items[idx]) {
        // förspel: förberedelse hemma (gul), restid (röd), på plats (gul) – smalt band ytterst i ringen
        const O = it.onsite || 0, T = it.travel || 0, Pp = it.prepare || 0;
        const st = +it.start, m = 60000, lw = ringW * 0.32, lr = r + ringW / 2 - lw / 2;
        if (it.countdown !== false) {
          rings += seg(lr, lw, new Date(st - (O + T + Pp) * m), new Date(st - (O + T) * m), SEV.yellow, 0.95);
          rings += seg(lr, lw, new Date(st - (O + T) * m), new Date(st - O * m), SEV.red, 0.95);
          rings += seg(lr, lw, new Date(st - O * m), new Date(st), SEV.yellow, 0.95);
        }
        const gap = (it.end - it.start) > 10 * m ? c.segment_gap * m : 0;
        rings += seg(r, ringW - 4, new Date(st + gap), new Date(+it.end - gap), it.color || color, 0.9);
        // tydlig radiell avgränsare i varje ände så att intilliggande block (t.ex. lektioner) syns som separata
        [it.start, it.end].forEach((t) => {
          if (t <= ws || t >= we) return;
          const [ax, ay] = P(r - ringW / 2 + 2, ang(t)), [bx, by] = P(r + ringW / 2 - 2, ang(t));
          seps += `<line x1="${f2(ax)}" y1="${f2(ay)}" x2="${f2(bx)}" y2="${f2(by)}" />`;
        });
        // ikon (eller lektionsnamn) mitt i den synliga delen
        const a = Math.max(+it.start, +ws), b = Math.min(+it.end, +we);
        const mid = new Date((a + b) / 2);
        const [x, y] = P(r, ang(mid));
        const arcLen = r * 2 * Math.PI * (b - a) / 86400000; // i viewBox-enheter
        const tip = esc(`${hm(it.start)}–${hm(it.end)} ${it.clean || it.title}`);
        const pastCls = mid < now ? ' past' : '';
        if (it.textLabel && !it.ruleIcon) {
          const txt = it.clean || it.title;
          const fs = Math.min(ringW * 0.42, arcLen / (Math.max(2, txt.length) * 0.9));
          if (fs >= 11) icons += `<div class="tl${pastCls}" title="${tip}" style="left:${x / 10}%;top:${y / 10}%;font-size:${(fs * S / 1000).toFixed(1)}px">${esc(txt)}</div>`;
        } else if (b - a >= 25 * m) {
          icons += `<ha-icon class="ic${pastCls}" icon="${esc(it.icon)}" title="${tip}" style="left:${x / 10}%;top:${y / 10}%"></ha-icon>`;
        }
      }
    });

    // Timmarkeringar och visare
    let ticks = '';
    for (let h = 0; h < 24; h++) {
      const a = ((h - 12) / 24) * 2 * Math.PI;
      const major = h % 6 === 0;
      const [x1, y1] = P(495, a), [x2, y2] = P(major ? 478 : 485, a), [lx, ly] = P(465, a);
      ticks += `<line x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}" stroke="#fff" stroke-opacity=".8" stroke-width="${major ? 4 : 2}" />`;
      ticks += `<text x="${f2(lx)}" y="${f2(ly)}" class="hl${major ? ' maj' : ''}">${pad(h)}</text>`;
    }
    const innerR = rOuter - (people.length - 1) * (ringW + ringGap) - ringW / 2 - 8;
    const [hx1, hy1] = P(innerR, ang(now)), [hx2, hy2] = P(495, ang(now));
    const [sx1, sy1] = P(innerR, ang(ws)), [sx2, sy2] = P(495, ang(ws));

    // Mitten: klocka + nästa per person
    const lines = this._events ? people.map((p, idx) => {
      const n = this._nextText(items[idx], now);
      return `<div class="nl"><b style="color:${p.color || 'inherit'}">${esc(p.name)}</b> <span style="color:${n.color}">${esc(n.text)}</span></div>`;
    }).join('') : '<div class="nl">Hämtar kalendrar…</div>';
    const wd = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'][now.getDay()];
    const mo = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][now.getMonth()];

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { background:none; box-shadow:none; border:none; padding:0; }
        .dial { position:relative; margin:0 auto; }
        .dial svg { position:absolute; top:0; left:0; width:100%; height:100%; }
        .hl { fill:#fff; fill-opacity:.75; font-size:20px; text-anchor:middle; dominant-baseline:central; font-family:inherit; }
        .hl.maj { font-size:26px; font-weight:700; fill-opacity:.95; }
        .ic { position:absolute; transform:translate(-50%,-50%); color:#fff; --mdc-icon-size:${Math.round(S * ringW * 0.62 / 1000)}px;
              filter:drop-shadow(0 0 2px rgba(0,0,0,.8)); }
        .ic.past, .tl.past { opacity:.4; }
        .tl { position:absolute; transform:translate(-50%,-50%); color:#fff; font-weight:700; white-space:nowrap; line-height:1;
              text-shadow:0 0 3px rgba(0,0,0,.9); pointer-events:auto; }
        .center { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:${Math.round(innerR * 1.55 / 10)}%;
                  text-align:center; color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.8); }
        .time { font-size:3.4em; font-weight:800; line-height:1; }
        .date { font-size:1.1em; opacity:.85; margin-bottom:.6em; }
        .nl { font-size:.95em; line-height:1.3; margin-top:.25em; }
      </style>
      <ha-card>
        <div class="dial" style="width:${S}px;height:${S}px;font-size:${(S / 46).toFixed(1)}px">
          <svg viewBox="0 0 1000 1000">
            <g>${sky}</g>
            <circle cx="500" cy="500" r="${innerR}" fill="rgba(0,0,0,.45)" />
            <g fill="none">${rings}</g>
            <g stroke="rgba(0,0,0,.75)" stroke-width="5">${seps}</g>
            ${ticks}
            <line x1="${f2(sx1)}" y1="${f2(sy1)}" x2="${f2(sx2)}" y2="${f2(sy2)}" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-dasharray="6 6" />
            <line x1="${f2(hx1)}" y1="${f2(hy1)}" x2="${f2(hx2)}" y2="${f2(hy2)}" stroke="#fff" stroke-width="5" stroke-linecap="round" />
          </svg>
          ${icons}
          <div class="center">
            <div class="time">${hm(now)}</div>
            <div class="date">${wd} ${now.getDate()} ${mo}</div>
            ${lines}
          </div>
        </div>
      </ha-card>`;
  }
}

const FTC_CARDS = [
  ['family-timeline-card', FamilyTimelineCard, 'Family Timeline', 'Dagens aktiviteter per person som tidslinje.'],
  ['family-action-card', FamilyActionCard, 'Family Action', 'Stor nedräkning per person och stora ikoner för det som behöver förberedas.'],
  ['family-sundial-card', FamilySundialCard, 'Family Sundial', 'Dygnet som 24-timmarsurtavla med solens gång och allas aktiviteter.'],
];
window.customCards = window.customCards || [];
for (const [tag, cls, name, description] of FTC_CARDS) {
  if (!customElements.get(tag)) {
    customElements.define(tag, cls);
    window.customCards.push({ type: tag, name, description });
  }
}
console.info(`%c family-cards ${FTC_VERSION} `, 'background:#075056;color:#fff');
