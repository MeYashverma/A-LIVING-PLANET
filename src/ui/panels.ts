/**
 * Instrument panels. Left column: the state of the world. Right column: tabbed
 * detail — the open organism's file, the species encyclopedia, the food web,
 * the history of this planet, lineage, sandbox controls and live simulation
 * counters. Every figure is read from the simulation; nothing is decorative.
 */
import { TIME } from '../core/config';
import { SEASON_NAMES } from '../core/time';
import { clamp01 } from '../core/math';
import { buildFoodWeb, SPECIES, speciesIndex } from '../life/species';
import { Action, MemKind, Stage } from '../life/organism';
import type { WorldEvent } from '../core/events';
import type { SimHost } from '../sim/host';
import { SimHost as HostClass } from '../sim/host';

export interface PanelCallbacks {
  onFocusSpecies(key: string): void;
  onFocusEvent(event: WorldEvent): void;
  onSelectOrganism(id: number): void;
  onFollow(id: number): void;
  onFavourite(id: number): void;
  onChange(): void;
}

type TabId = 'organism' | 'species' | 'web' | 'history' | 'lineage' | 'sandbox' | 'stats';

const TABS: { id: TabId; label: string }[] = [
  { id: 'organism', label: 'Organism' },
  { id: 'species', label: 'Species' },
  { id: 'web', label: 'Food web' },
  { id: 'history', label: 'History' },
  { id: 'lineage', label: 'Lineage' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'stats', label: 'Sim' },
];

export class Panels {
  private host: SimHost;
  private cb: PanelCallbacks;
  private left: HTMLElement;
  private right: HTMLElement;
  private leftBody: HTMLElement;
  private rightBody: HTMLElement;
  private tabButtons = new Map<TabId, HTMLButtonElement>();
  private active: TabId = 'organism';
  private speciesKey: string | null = null;
  private hidden = false;
  private accum = 0;
  private webHover: string | null = null;
  private webLayout: { key: string; x: number; y: number; r: number; level: number }[] = [];
  private lastEventCount = 0;

  constructor(host: SimHost, cb: PanelCallbacks) {
    this.host = host;
    this.cb = cb;

    this.left = document.createElement('div');
    this.left.className = 'ui';
    this.left.id = 'leftcol';
    const leftPanel = panel('World vitals');
    this.leftBody = leftPanel.body;
    this.left.append(leftPanel.root);

    this.right = document.createElement('div');
    this.right.className = 'ui';
    this.right.id = 'rightcol';
    const rightPanel = panel('Field notes');
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.type = 'button';
      b.textContent = t.label;
      b.addEventListener('click', () => this.setTab(t.id));
      this.tabButtons.set(t.id, b);
      tabs.append(b);
    }
    rightPanel.root.append(tabs);
    this.rightBody = rightPanel.body;
    this.rightBody.classList.add('scroll');
    this.right.append(rightPanel.root);

    document.body.append(this.left, this.right);
    this.setTab('organism');
  }

  setTab(id: TabId): void {
    this.active = id;
    for (const [k, b] of this.tabButtons) b.classList.toggle('on', k === id);
    this.render(true);
  }

  togglePanels(): void {
    this.hidden = !this.hidden;
    this.left.style.display = this.hidden ? 'none' : '';
    this.right.style.display = this.hidden ? 'none' : '';
  }

  get panelsHidden(): boolean {
    return this.hidden;
  }

  /** Called every frame; DOM work is throttled to ~4 Hz. */
  update(dt: number, rendererFps: number): void {
    this.accum += dt;
    if (this.accum < 0.25) return;
    this.accum = 0;
    if (!this.hidden) {
      this.render(false);
      void rendererFps;
    }
  }

  private render(force: boolean): void {
    void force;
    this.renderVitals();
    switch (this.active) {
      case 'organism':
        this.renderOrganism();
        break;
      case 'species':
        this.renderSpecies();
        break;
      case 'web':
        this.renderWeb();
        break;
      case 'history':
        this.renderHistory();
        break;
      case 'lineage':
        this.renderLineage();
        break;
      case 'sandbox':
        this.renderSandbox();
        break;
      case 'stats':
        this.renderStats();
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Left column: vitals                                                 */
  /* ------------------------------------------------------------------ */

  private renderVitals(): void {
    const world = this.host.world;
    const bd = world.census.biodiversity;
    const body = this.leftBody;
    body.replaceChildren();

    const vitality = el('div');
    vitality.append(stat('Vitality', `${(bd.vitality * 100).toFixed(0)}%`));
    const bar = meterBar(bd.vitality, bd.vitality > 0.55 ? 'good' : bd.vitality > 0.3 ? '' : 'bad');
    vitality.append(bar);
    body.append(vitality);

    const grid = el('div', 'grid2');
    grid.append(
      stat('Species', `${bd.speciesRichness}/${bd.speciesPossible}`),
      stat('Evenness', bd.evenness.toFixed(2)),
      stat('Shannon H', bd.shannon.toFixed(2)),
      stat('Stability', bd.stability.toFixed(2)),
      stat('Biomass', compact(bd.totalBiomass)),
      stat('Vegetation', `${(bd.vegetationIndex * 100).toFixed(0)}%`),
      stat('Forest', compact(bd.forestBiomass)),
      stat('Water', `${(bd.waterAvailability * 100).toFixed(0)}%`),
      stat('Soil', `${(bd.soilHealth * 100).toFixed(0)}%`),
      stat('Pred/Prey', bd.predatorPreyRatio.toFixed(2)),
      stat('Disease', `${(bd.diseasePressure * 100).toFixed(0)}%`),
      stat('Animals', String(world.stats.creatures)),
    );
    body.append(grid);

    // Weather + fire + disease pressure, all measured.
    const env = el('div', 'section');
    env.append(sectionTitle('Conditions'));
    const grid2 = el('div', 'grid2');
    const climate = world.climate;
    grid2.append(
      stat('Weather', climate.state),
      stat('Temp', `${climate.temperatureAt(0, 0).toFixed(1)}°C`),
      stat('Wind', `${climate.windSpeed.toFixed(1)} m/s`),
      stat('Rain', `${(climate.rainIntensity.stats().mean * 100).toFixed(0)}%`),
      stat('Smoke', `${(clamp01(world.fire.smoke) * 100).toFixed(0)}%`),
      stat('Carcasses', String(world.carcasses.count)),
    );
    env.append(grid2);
    for (const e of climate.events) {
      env.append(chip(`${e.label} · ${Math.max(0, Math.ceil(e.remaining))} d`, true));
    }
    body.append(env);

    const list = el('div', 'section');
    list.append(sectionTitle('Populations'));
    const stats = world.census.ordered();
    for (const s of stats) {
      const row = el('div', 'species-row');
      const name = el('div', 'name');
      name.textContent = s.name;
      const count = el('div', 'value');
      count.textContent = String(s.count);
      const trend = el('div', 'value small');
      trend.textContent = `${s.trend > 0.02 ? '↑' : s.trend < -0.02 ? '↓' : '→'} ${s.trend >= 0 ? '+' : ''}${(s.trend * 100).toFixed(0)}%`;
      trend.className = `value small ${s.trend > 0.02 ? 'trend-up' : s.trend < -0.02 ? 'trend-down' : 'faint'}`;
      const barWrap = el('div');
      const max = Math.max(1, ...stats.map((x) => x.count));
      barWrap.append(meterBar(s.count / max, s.extinct ? 'bad' : ''));
      row.append(name, count, barWrap, trend);
      row.addEventListener('click', () => {
        this.speciesKey = s.key;
        this.cb.onFocusSpecies(s.key);
        this.setTab('species');
      });
      list.append(row);
    }
    body.append(list);

    const feed = el('div', 'section');
    feed.append(sectionTitle('Recent observations'));
    const events = world.history.events.slice(-9).reverse();
    for (const e of events) {
      const node = el('div', 'event');
      const t = el('div', 't');
      const day = el('span', 'value faint small');
      day.textContent = `D${e.day}`;
      const title = el('span', 'small');
      title.textContent = e.title;
      t.append(day, title);
      node.append(t);
      node.addEventListener('click', () => this.cb.onFocusEvent(e));
      feed.append(node);
    }
    body.append(feed);

    if (world.errors.length) {
      const errs = el('div', 'section');
      errs.append(sectionTitle('Simulation notes'));
      for (const e of world.errors.slice(-3)) {
        const p = el('div', 'small faint');
        p.textContent = e;
        errs.append(p);
      }
      body.append(errs);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Organism file                                                       */
  /* ------------------------------------------------------------------ */

  private renderOrganism(): void {
    const body = this.rightBody;
    const world = this.host.world;
    const id = this.host.selectedId;
    if (id === null) {
      body.replaceChildren(hint('No organism selected. Click any animal in the world — or any row in the population list — to open its file.'));
      return;
    }
    const p = this.host.profile(id);
    if (!p) {
      body.replaceChildren(hint('That animal has died. Its record is kept in the world history.'));
      return;
    }
    body.replaceChildren();

    const head = el('div', 'insp-head');
    const swatch = el('div', 'insp-swatch');
    const sp = SPECIES[speciesIndex(p.species)];
    swatch.style.background = sp ? `hsl(${(speciesIndex(p.species) * 47) % 360} 28% 42%)` : '#333';
    const titles = el('div', 'grow');
    const name = el('div', 'insp-name');
    name.textContent = `${p.sex === 'female' ? '♀' : '♂'} ${p.speciesName} #${p.id}`;
    const sub = el('div', 'insp-sub');
    sub.textContent = `${p.latin} · ${p.role} · gen ${p.generation}`;
    const chips = el('div', 'row tight wrap');
    chips.style.marginTop = '4px';
    chips.append(
      chip(Stage[p.stage as unknown as number] ?? p.stage, false),
      chip(p.action, p.action === 'Hunt' || p.action === 'Flee'),
      chip(this.host.regionAt(p.x, p.y), false),
      p.pregnant ? chip(`pregnant · ${p.fetusCount}`, true) : chip(p.sex === 'female' ? 'not pregnant' : p.health > 0.7 ? 'in condition' : 'poor condition', false),
    );
    titles.append(name, sub, chips);
    head.append(swatch, titles);
    body.append(head);

    const meters = el('div');
    meters.append(
      meter('Health', p.health),
      meter('Energy', p.energy),
      meter('Hunger', p.hunger, true),
      meter('Thirst', p.thirst, true),
      meter('Fatigue', p.fatigue, true),
      meter('Warmth', p.warmth, true),
      meter('Injury', p.injury, true, 'bad'),
      meter('Fear', p.fear, true, 'warn'),
    );
    body.append(meters);

    const life = el('div', 'section');
    life.append(sectionTitle('Life history'));
    const grid = el('div', 'grid2');
    grid.append(
      stat('Age', `${p.ageYears.toFixed(2)} y`),
      stat('Stage', Stage[p.stage as unknown as number] ?? p.stage),
      stat('Body', `${p.bodyLength.toFixed(2)} m · ${p.massKg.toFixed(1)} kg`),
      stat('Speed', `${p.speed.toFixed(2)} m/min`),
      stat('Ate', `${p.ateHoursAgo.toFixed(1)} h ago`),
      stat('Drank', `${p.drankHoursAgo.toFixed(1)} h ago`),
      stat('Kills', String(p.kills)),
      stat('Meals', String(p.meals)),
      stat('Travelled', `${(p.distanceTravelled / 1000).toFixed(2)} km`),
      stat('Generation', String(p.generation)),
      stat('Gestation left', p.pregnant ? `${p.gestationLeftDays.toFixed(1)} d` : '—'),
      stat('Nursing', p.nursingDays > 0.01 ? `${p.nursingDays.toFixed(1)} d` : '—'),
    );
    life.append(grid);
    body.append(life);

    const goal = el('div', 'section');
    goal.append(sectionTitle('Now'));
    const g = el('div', 'grid2');
    g.append(
      stat('Action', p.action),
      stat('Goal', p.goal),
      stat('Target', p.goalTarget ? `${p.goalTarget.x.toFixed(0)}, ${p.goalTarget.y.toFixed(0)}` : '—'),
      stat('Position', `${p.x.toFixed(0)}, ${p.y.toFixed(0)}`),
      stat('Group', p.group ? `${p.group.name} (${p.group.size})` : 'solitary'),
      stat('Role', p.group?.role ?? '—'),
      stat('Home', p.home ? `${p.home.kind} at ${p.home.x.toFixed(0)}, ${p.home.y.toFixed(0)}` : 'none'),
      stat('Territory', p.territory ? `r ${p.territory.radius.toFixed(0)} m` : '—'),
    );
    goal.append(g);
    if (p.goalTarget) {
      const b = buttonRow([
        ['Walk there', () => this.host.relocateSelected(p.goalTarget!.x, p.goalTarget!.y)],
      ]);
      goal.append(b);
    }
    body.append(goal);

    const traits = el('div', 'section');
    traits.append(sectionTitle('Heritable traits (against population mean)'));
    for (const t of p.traits) {
      const row = el('div', 'trait-row');
      const label = el('div', 'small dim');
      label.textContent = t.label;
      const track = el('div', 'trait-track');
      const pop = el('div', 'pop');
      // Population band: mean ± 1σ, clamped to the track.
      const lo = clamp01(t.mean - t.sigma);
      const hi = clamp01(t.mean + t.sigma);
      pop.style.left = `${lo * 100}%`;
      pop.style.width = `${Math.max(2, (hi - lo) * 100)}%`;
      const me = el('div', 'me');
      me.style.left = `${clamp01(t.value) * 100}%`;
      track.append(pop, me);
      const value = el('div', 'value small');
      value.textContent = t.value.toFixed(2);
      row.append(label, track, value);
      traits.append(row);
    }
    const personality = el('div', 'legend');
    for (const t of p.personality) personality.append(span2('', `${t.key} ${t.value.toFixed(2)}`));
    traits.append(personality);
    body.append(traits);

    const memory = el('div', 'section');
    memory.append(sectionTitle('Known places'));
    if (!p.memory.length) memory.append(hint('Nothing remembered yet — memory is built by experience, not given.'));
    for (const m of p.memory) {
      const row = el('div', 'stat');
      row.append(span2('k', m.label), span2('v', `${m.distance.toFixed(0)} m · ${(m.strength * 100).toFixed(0)}%`));
      memory.append(row);
    }
    body.append(memory);

    const family = el('div', 'section');
    family.append(sectionTitle('Relations'));
    const fam = el('div', 'grid2');
    fam.append(
      stat('Mother', p.parents.mother > 0 ? `#${p.parents.mother}` : 'unknown'),
      stat('Father', p.parents.father > 0 ? `#${p.parents.father}` : 'unknown'),
      stat('Offspring', String(p.offspring.length)),
      stat('Litter size', litterOf(p.species)),
      stat('Mate', p.mates.length ? `#${p.mates[0]}` : 'none'),
      stat('Infection', p.infection.infected ? `${p.infection.pathogen} (${p.infection.days.toFixed(1)} d)` : 'clear'),
      stat('Immunity', `${(p.infection.immunity * 100).toFixed(0)}%`),
      stat('Condition', `${(p.condition * 100).toFixed(0)}%`),
    );
    family.append(fam);
    body.append(family);

    const events = el('div', 'section');
    events.append(sectionTitle('Recorded events'));
    if (!p.recentEvents.length) events.append(hint('No notable events for this animal yet.'));
    for (const e of p.recentEvents.reverse()) {
      const node = el('div', 'event');
      const t = el('div', 't');
      t.append(span2('value faint small', `D${e.day}`), span2('small', e.title));
      node.append(t);
      events.append(node);
      void world;
    }
    body.append(events);

    const actions = el('div', 'section');
    actions.append(sectionTitle('Observation'));
    actions.append(
      buttonRow([
        ['Follow', () => this.cb.onFollow(p.id)],
        [this.host.favourites.includes(p.id) ? '★ Favourite' : '☆ Favourite', () => this.cb.onFavourite(p.id)],
        ['Centre', () => this.host.follow(p.id)],
        ['Family', () => this.setTab('lineage')],
        ['Compare A', () => (this.host.compareA = p.id)],
        ['Compare B', () => (this.host.compareB = p.id)],
      ]),
    );
    if (this.host.compareA !== null && this.host.compareB !== null) {
      const other = this.host.profile(this.host.compareA === p.id ? this.host.compareB : this.host.compareA);
      if (other) actions.append(this.compareTable(p, other));
    }
    actions.append(
      buttonRow([
        ['Clone', () => this.host.cloneSelected()],
        ['Remove', () => this.host.removeSelected()],
      ]),
    );
    body.append(actions);
  }

  private compareTable(a: NonNullable<ReturnType<SimHost['profile']>>, b: NonNullable<ReturnType<SimHost['profile']>>): HTMLElement {
    const table = document.createElement('table');
    table.className = 'data';
    const head = document.createElement('tr');
    head.append(th('Metric'), th(`#${a.id}`), th(`#${b.id}`));
    table.append(head);
    const rows: [string, string, string][] = [
      ['Species', a.speciesName, b.speciesName],
      ['Age (y)', a.ageYears.toFixed(2), b.ageYears.toFixed(2)],
      ['Mass (kg)', a.massKg.toFixed(1), b.massKg.toFixed(1)],
      ['Health', a.health.toFixed(2), b.health.toFixed(2)],
      ['Energy', a.energy.toFixed(2), b.energy.toFixed(2)],
      ['Hunger', a.hunger.toFixed(2), b.hunger.toFixed(2)],
      ['Generation', String(a.generation), String(b.generation)],
      ['Speed trait', trait(a, 'speed'), trait(b, 'speed')],
      ['Vision trait', trait(a, 'vision'), trait(b, 'vision')],
      ['Aggression', trait(a, 'aggression'), trait(b, 'aggression')],
      ['Resistance', trait(a, 'diseaseResist'), trait(b, 'diseaseResist')],
      ['Metabolism', trait(a, 'metabolism'), trait(b, 'metabolism')],
    ];
    for (const [k, x, y] of rows) {
      const tr = document.createElement('tr');
      tr.append(td(k, true), td(x), td(y));
      table.append(tr);
    }
    return table;
  }

  /* ------------------------------------------------------------------ */
  /* Species encyclopedia                                                */
  /* ------------------------------------------------------------------ */

  private renderSpecies(): void {
    const body = this.rightBody;
    const world = this.host.world;
    const key = this.speciesKey ?? world.census.ordered()[0]?.key;
    if (!key) {
      body.replaceChildren(hint('No species data yet.'));
      return;
    }
    this.speciesKey = key;
    const sp = SPECIES[speciesIndex(key)];
    const stat0 = world.census.get(key);
    body.replaceChildren();
    if (!sp || !stat0) {
      body.replaceChildren(hint('Unknown species.'));
      return;
    }

    const head = el('div', 'insp-head');
    const swatch = el('div', 'insp-swatch');
    swatch.style.background = `hsl(${(speciesIndex(key) * 47) % 360} 28% 42%)`;
    const titles = el('div', 'grow');
    const name = el('div', 'insp-name');
    name.textContent = `${sp.name}`;
    const sub = el('div', 'insp-sub');
    sub.textContent = `${sp.latin} · ${sp.role}`;
    const chips = el('div', 'row tight wrap');
    chips.style.marginTop = '4px';
    chips.append(
      chip(stat0.extinct ? 'extinct here' : `${stat0.count} alive`, stat0.extinct),
      chip(`gen ${stat0.maxGeneration}`),
      chip(`${stat0.birthsThisYear} births / ${stat0.deathsThisYear} deaths this year`),
      chip(world.history.hasSeenSpecies(speciesIndex(key)) ? 'observed' : 'not yet seen', false),
    );
    titles.append(name, sub, chips);
    head.append(swatch, titles);
    body.append(head);

    const desc = el('p', 'small dim');
    desc.textContent = sp.blurb;
    body.append(desc);

    const numbers = el('div', 'section');
    numbers.append(sectionTitle('Measured now'));
    const grid = el('div', 'grid3');
    grid.append(
      stat('Count', String(stat0.count)),
      stat('Biomass', compact(stat0.biomass)),
      stat('Mean age', `${stat0.meanAgeYears.toFixed(2)} y`),
      stat('Lifespan', `${stat0.lifespanYears.toFixed(1)} y`),
      stat('Health', stat0.meanHealth.toFixed(2)),
      stat('Hunger', stat0.meanHunger.toFixed(2)),
      stat('Range', `${stat0.habitatRange.toFixed(0)}%`),
      stat('Territories', String(stat0.territoryCount)),
      stat('Groups', String(stat0.groupCount)),
      stat('Disease', `${(stat0.diseasePrevalence * 100).toFixed(0)}%`),
      stat('Layer', stat0.layers),
      stat('Trend', `${stat0.trend >= 0 ? '+' : ''}${(stat0.trend * 100).toFixed(0)}%`),
    );
    numbers.append(grid);
    const bar = meterBar(clamp01(stat0.trend * 2 + 0.5), stat0.trend >= 0 ? 'good' : 'bad');
    numbers.append(bar);
    body.append(numbers);

    const chart = el('div', 'section');
    chart.append(sectionTitle('Population history'));
    chart.append(lineChart(world.history.series(speciesIndex(key)), 210, 62));
    body.append(chart);

    const ecology = el('div', 'section');
    ecology.append(sectionTitle('Ecological role'));
    const eco = el('div');
    eco.append(
      stat('Diet', `${sp.dietKind} — ${describeDiet(sp)}`),
      stat('Hunts', stat0.prey.slice(0, 5).join(', ') || 'nothing'),
      stat('Hunted by', stat0.predators.slice(0, 5).join(', ') || 'nothing'),
      stat('Activity', sp.activity),
      stat('Social', sp.social),
      stat('Shelter', sp.shelter),
      stat('Gestation', `${sp.gestationDays} d`),
      stat('Litter', `${sp.litterSize[0]}–${sp.litterSize[1]}`),
      stat('Breeding', sp.breedingSeasons.length ? sp.breedingSeasons.map((i) => SEASON_NAMES[i]).join(', ') : 'year-round'),
      stat('Maturity', `${sp.maturityYears.toFixed(2)} y`),
      stat('Temp comfort', `${sp.tempComfort[0]}–${sp.tempComfort[1]} °C`),
    );
    ecology.append(eco);
    body.append(ecology);

    const traits = el('div', 'section');
    traits.append(sectionTitle('Population traits'));
    const table = document.createElement('table');
    table.className = 'data';
    table.append(rowOf(['Trait', 'Mean', 'Range']));
    for (const t of stat0.traits) {
      table.append(rowOf([t.label, t.value.toFixed(3), `${(t.normalised * 100).toFixed(0)}%`]));
    }
    traits.append(table);
    const series = world.history.traitSeries(speciesIndex(key), 0);
    if (series.length > 2) {
      traits.append(lineChart(series, 210, 54));
      traits.append(hint('Fastest-changing measured trait across generations (speed). A rising line is selection, not a script.'));
    }
    body.append(traits);

    const action = el('div', 'section');
    action.append(buttonRow([['Find one', () => this.cb.onFocusSpecies(key)], ['Sandbox spawn', () => (this.host.spawnSpecies = key)]]));
    body.append(action);
  }

  /* ------------------------------------------------------------------ */
  /* Food web                                                            */
  /* ------------------------------------------------------------------ */

  private renderWeb(): void {
    const body = this.rightBody;
    const world = this.host.world;
    body.replaceChildren();
    const web = buildFoodWeb();
    const canvas = document.createElement('canvas');
    canvas.className = 'chart';
    const width = 344;
    const height = 300;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Lay the web out by trophic depth: producers left, apex predators right.
    const depth = new Map<string, number>();
    const edges = web.edges;
    for (const key of web.nodes) depth.set(key, 1);
    for (let pass = 0; pass < 6; pass++) {
      for (const e of edges) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1));
    }
    const levels = new Map<number, string[]>();
    for (const key of web.nodes) {
      const d = depth.get(key) ?? 1;
      if (!levels.has(d)) levels.set(d, []);
      levels.get(d)!.push(key);
    }
    const maxLevel = Math.max(...levels.keys());
    this.webLayout = [];
    for (const [level, keys] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
      keys.forEach((key, i) => {
        const x = 40 + (level / Math.max(1, maxLevel)) * (width - 80);
        const y = ((i + 1) / (keys.length + 1)) * (height - 30) + 15;
        const count = populationOf(world, key);
        const r = Math.max(4, Math.min(18, 3 + Math.log10(1 + count) * 4));
        this.webLayout.push({ key, x, y, r, level });
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const pos = new Map(this.webLayout.map((n) => [n.key, n]));
      // Edges: thickness from real predation weight, brightness from activity.
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const hot = this.webHover === e.from || this.webHover === e.to;
        ctx.strokeStyle = hot ? 'rgba(200,135,60,0.85)' : 'rgba(120,132,140,0.24)';
        ctx.lineWidth = hot ? 1.6 : Math.max(0.4, Math.min(2.4, e.weight * 2.2));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 + (a.y - b.y) * 0.12;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.stroke();
      }
      for (const n of this.webLayout) {
        const sp = SPECIES[speciesIndex(n.key)];
        const count = populationOf(world, n.key);
        const hot = this.webHover === n.key;
        const hue = (speciesIndex(n.key) * 47) % 360;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (hot ? 2 : 0), 0, Math.PI * 2);
        ctx.fillStyle = count > 0 ? `hsl(${hue} 34% ${hot ? 52 : 40}%)` : 'rgba(70,78,84,0.6)';
        ctx.fill();
        ctx.strokeStyle = hot ? 'rgba(220,180,120,0.9)' : 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = count > 0 ? 'rgba(230,226,216,0.92)' : 'rgba(150,158,164,0.7)';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        const label = n.key.length > 9 ? n.key.slice(0, 8) : n.key;
        ctx.fillText(label, n.x, n.y - n.r - 3);
        void sp;
      }
    };
    draw();
    body.append(canvas);
    const readout = el('div', 'small dim');
    readout.textContent = this.webHover ? `${this.webHover}: ${populationOf(world, this.webHover)} individuals` : 'Hover a node. Node size is measured population; line weight is predation pressure.';
    body.append(readout);
    canvas.style.pointerEvents = 'auto';
    canvas.addEventListener('mousemove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * width;
      const y = ((ev.clientY - rect.top) / rect.height) * height;
      let hover: string | null = null;
      for (const n of this.webLayout) {
        if (Math.hypot(n.x - x, n.y - y) < n.r + 6) hover = n.key;
      }
      if (hover !== this.webHover) {
        this.webHover = hover;
        draw();
        readout.textContent = hover ? `${hover}: ${populationOf(world, hover)} individuals` : 'Hover a node. Node size is measured population; line weight is predation pressure.';
      }
    });
    canvas.addEventListener('click', () => {
      if (this.webHover) {
        this.speciesKey = this.webHover;
        this.setTab('species');
      }
    });

    const extinct = SPECIES.filter((s) => world.census.get(s.key)?.extinct);
    if (extinct.length) {
      const warn = el('div', 'section');
      warn.append(sectionTitle('Missing from this web'));
      warn.append(hint(`${extinct.map((s) => s.name).join(', ')} — locally extinct. Their links are drawn but unfed.`));
      body.append(warn);
    }
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  private renderHistory(): void {
    const body = this.rightBody;
    const world = this.host.world;
    if (world.history.events.length === this.lastEventCount && body.childElementCount > 0 && this.active === 'history') {
      // Nothing new; avoid rebuilding the DOM every tick.
    }
    this.lastEventCount = world.history.events.length;
    body.replaceChildren();

    const counters = el('div', 'section');
    counters.append(sectionTitle('This planet so far'));
    const grid = el('div', 'grid2');
    grid.append(
      stat('Days', String(world.clock.day)),
      stat('Years', world.clock.year.toFixed(2)),
      stat('Events', String(world.history.events.length)),
      stat('Discoveries', String(world.history.discoveries.length)),
      stat('Individuals logged', String(world.history.individuals.size)),
      stat('Generations', String(maxGeneration(world))),
      stat('Fires', String(world.history.events.filter((e) => e.kind === 'disaster').length)),
      stat('Disease outbreaks', String(world.disease.history.length)),
    );
    counters.append(grid);
    body.append(counters);

    const discoveries = el('div', 'section');
    discoveries.append(sectionTitle('Scientific firsts'));
    if (!world.history.discoveries.length) discoveries.append(hint('Nothing logged yet. Firsts are recorded when a real event is observed — a first predation, a first migration, a first epidemic.'));
    for (const d of world.history.discoveries.slice(-14).reverse()) {
      const node = el('div', 'event');
      const t = el('div', 't');
      t.append(span2('value faint small', `Y${d.year} D${d.day}`), span2('small', d.title));
      node.append(t);
      const detail = el('div', 'd');
      detail.textContent = d.detail;
      node.append(detail);
      discoveries.append(node);
    }
    body.append(discoveries);

    const timeline = el('div', 'section');
    timeline.append(sectionTitle('World history'));
    const events = world.history.events.slice(-40).reverse();
    for (const e of events) {
      const node = el('div', 'event');
      const t = el('div', 't');
      const w = el('span', 'value');
      w.textContent = '•'.repeat(Math.min(3, Math.max(1, e.weight)));
      w.style.color = e.weight >= 3 ? 'var(--bad)' : e.weight >= 2 ? 'var(--accent)' : 'var(--text-faint)';
      t.append(span2('value faint small', `Y${e.year} D${e.day}`), w, span2('small', e.title));
      node.append(t);
      if (e.detail) {
        const d = el('div', 'd');
        d.textContent = e.detail;
        node.append(d);
      }
      node.addEventListener('click', () => this.cb.onFocusEvent(e));
      timeline.append(node);
    }
    body.append(timeline);
  }

  /* ------------------------------------------------------------------ */
  /* Lineage                                                             */
  /* ------------------------------------------------------------------ */

  private renderLineage(): void {
    const body = this.rightBody;
    const world = this.host.world;
    body.replaceChildren();
    const id = this.host.selectedId;
    if (id === null) {
      body.replaceChildren(hint('Select an animal to see its lineage. Family trees are built from real parent–offspring records kept since the world began.'));
      return;
    }
    const record = world.history.individual(id);
    const profile = this.host.profile(id);
    if (!record && !profile) {
      body.replaceChildren(hint('No record for that individual.'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'chart';
    const width = 344;
    const height = 240;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Three generations around the subject: parents, siblings/self, children.
    const self = record ?? null;
    const parents = (self?.parents ?? [0, 0]).filter((x) => x > 0);
    const children = (profile?.offspring ?? []).slice(0, 12);
    const mothersChildren = self && self.parents[0] > 0 ? (world.history.childrenOf(self.parents[0]).map((r) => r.id) ?? []) : [];
    const siblings = mothersChildren.filter((c: number) => c !== id).slice(0, 6);

    const nodeAt = (n: { id: number; gen: number }, x: number, y: number) => {
      const p = n.id === id ? profile : null;
      const spKey = p?.species ?? SPECIES[self?.speciesIdx ?? 0]?.key ?? '';
      const hue = (speciesIndex(spKey) * 47) % 360;
      ctx.beginPath();
      ctx.arc(x, y, n.id === id ? 15 : 11, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue} 30% ${n.id === id ? 48 : 34}%)`;
      ctx.fill();
      ctx.strokeStyle = n.id === id ? 'rgba(220,180,120,0.95)' : 'rgba(255,255,255,0.2)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,228,218,0.92)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`#${n.id}`, x, y + 3);
    };

    ctx.clearRect(0, 0, width, height);
    const midY = height / 2;
    const parentY = 40;
    const childY = height - 40;
    // Connectors first.
    const parentXs = parents.map((_: number, i: number) => (width / (parents.length + 1)) * (i + 1));
    const childXs = children.map((_: number, i: number) => (width / (children.length + 1)) * (i + 1));
    ctx.strokeStyle = 'rgba(120,132,140,0.4)';
    ctx.lineWidth = 1;
    for (const x of parentXs) {
      ctx.beginPath();
      ctx.moveTo(x, parentY + 12);
      ctx.lineTo(width / 2, midY - 14);
      ctx.stroke();
    }
    for (const x of childXs) {
      ctx.beginPath();
      ctx.moveTo(width / 2, midY + 14);
      ctx.lineTo(x, childY - 12);
      ctx.stroke();
    }
    parents.forEach((pid: number, i: number) => nodeAt({ id: pid, gen: 0 }, parentXs[i], parentY));
    nodeAt({ id, gen: 1 }, width / 2, midY);
    children.forEach((cid: number, i: number) => nodeAt({ id: cid, gen: 2 }, childXs[i], childY));
    if (siblings.length) {
      ctx.fillStyle = 'rgba(154,163,169,0.9)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`siblings: ${siblings.map((s: number) => `#${s}`).join(' ')}`, width / 2, midY + 34);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(107,117,124,0.9)';
    ctx.fillText('parents', 6, 14);
    ctx.fillText('subject', 6, midY - 4);
    ctx.fillText('offspring', 6, height - 64);
    body.append(canvas);

    const stats = el('div', 'section');
    stats.append(sectionTitle('Generation view'));
    const series = world.history.traitSeries(speciesIndex(profile?.species ?? SPECIES[self?.speciesIdx ?? 0]?.key ?? 'rabbit'), 0);
    if (series.length > 2) {
      stats.append(lineChart(series, 320, 70));
      stats.append(hint('Mean speed trait of the population, sampled as the world runs. Selection appears as a trend, never as a script.'));
    } else {
      stats.append(hint('Trait history needs more simulated days; the world samples trait means as generations turn over.'));
    }
    body.append(stats);

    const table = el('div', 'section');
    table.append(sectionTitle('Lineage'));
    const t = document.createElement('table');
    t.className = 'data';
    t.append(rowOf(['Relation', 'ID', 'Born', 'Died']));
    const rows: [string, number][] = [
      ...parents.map((p) => ['parent', p] as [string, number]),
      [id === 0 ? '' : 'subject', id],
      ...children.map((c) => ['offspring', c] as [string, number]),
    ];
    for (const [rel, rid] of rows) {
      const rec = world.history.individual(rid);
      t.append(rowOf([rel, `#${rid}`, rec ? `D${Math.round(rec.birthDay)}` : '—', rec && rec.deathDay !== null ? `D${Math.round(rec.deathDay)}` : 'alive']));
    }
    table.append(t);
    body.append(table);
  }

  /* ------------------------------------------------------------------ */
  /* Sandbox                                                             */
  /* ------------------------------------------------------------------ */

  private renderSandbox(): void {
    const body = this.rightBody;
    const world = this.host.world;
    body.replaceChildren();
    body.append(hint('Sandbox controls act on the world immediately. Terrain edits change wind and rain shadow; water carves new drainage; fire follows fuel and wind.'));

    const weather = el('div', 'section');
    weather.append(sectionTitle('Weather injection'));
    const weatherButtons = ['clear', 'fair', 'cloudy', 'overcast', 'drizzle', 'rain', 'heavyRain', 'storm', 'fog', 'snow'].map(
      (state) => [state, () => this.host.world.setWeather(state, 1)] as [string, () => void],
    );
    weather.append(buttonRow(weatherButtons, true));
    weather.append(
      buttonRow([
        ['Drought', () => this.host.world.startClimateEvent('drought', 12, 0.8)],
        ['Heatwave', () => this.host.world.startClimateEvent('heatwave', 6, 0.8)],
        ['Cold snap', () => this.host.world.startClimateEvent('coldwave', 6, 0.8)],
        ['Monsoon', () => this.host.world.startClimateEvent('monsoon', 14, 0.9)],
        ['Volcanic winter', () => this.host.world.startClimateEvent('volcanicWinter', 20, 0.7)],
      ]),
    );
    if (world.climate.events.length) {
      const active = el('div', 'row tight wrap');
      for (const e of world.climate.events) active.append(chip(`${e.label} ${Math.ceil(e.remaining)}d`, true));
      weather.append(active);
    }
    body.append(weather);

    const disasters = el('div', 'section');
    disasters.append(sectionTitle('Disasters'));
    disasters.append(
      buttonRow([
        ['Lightning strike', () => strikeCentre(world, 'fire')],
        ['Wildfire', () => strikeCentre(world, 'wildfire')],
        ['Meteor', () => strikeCentre(world, 'meteor')],
        ['Earthquake', () => strikeCentre(world, 'quake')],
        ['Volcano', () => world.eruptVolcano(0)],
        ['Flood', () => strikeCentre(world, 'flood')],
      ]),
    );
    body.append(disasters);

    const life = el('div', 'section');
    life.append(sectionTitle('Life'));
    const speciesPick = document.createElement('select');
    for (const sp of SPECIES) {
      const opt = document.createElement('option');
      opt.value = sp.key;
      opt.textContent = sp.name;
      speciesPick.append(opt);
    }
    speciesPick.value = this.host.spawnSpecies;
    speciesPick.addEventListener('change', () => (this.host.spawnSpecies = speciesPick.value));
    life.append(speciesPick);
    life.append(
      buttonRow([
        ['Introduce 6 here', () => strikeCentreWithSpecies(world, this.host.spawnSpecies, 6)],
        ['Remove all of species', () => {
          const sp = SPECIES[speciesIndex(this.host.spawnSpecies)];
          if (!sp) return;
          let removed = 0;
          for (let i = 0; i < world.creatures.capacity; i++) {
            if (world.creatures.alive[i] && world.creatures.speciesIdx[i] === speciesIndex(this.host.spawnSpecies)) {
              world.removeOrganism(world.creatures.id[i], 'culled by observer');
              removed++;
            }
          }
          this.host.toast(`Removed ${removed} ${sp.name.toLowerCase()}.`, 'spawn');
        }],
        ['Seed vegetation', () => strikeCentreWithSpecies(world, 'grass', 0, true)],
      ]),
    );
    body.append(life);

    const veg = el('div', 'section');
    veg.append(sectionTitle('Vegetation tools'));
    veg.append(
      buttonRow([
        ['Grass', () => (this.host as unknown as { vegLayer: number }).vegLayer = 0],
        ['Shrubs', () => (this.host as unknown as { vegLayer: number }).vegLayer = 1],
        ['Reeds', () => (this.host as unknown as { vegLayer: number }).vegLayer = 2],
      ]),
    );
    veg.append(hint('Pick a layer, then use the Sow tool on the map.'));
    body.append(veg);

    const disease = el('div', 'section');
    disease.append(sectionTitle('Disease'));
    disease.append(
      buttonRow([
        ['Outbreak here', () => strikeCentre(world, 'disease')],
        ['Vaccinate species', () => {
          for (let i = 0; i < world.creatures.capacity; i++) {
            if (world.creatures.alive[i] && world.creatures.speciesIdx[i] === speciesIndex(this.host.spawnSpecies)) {
              world.creatures.infection[i] = 0;
              world.creatures.immunity[i] = 1;
            }
          }
          this.host.toast(`${this.host.spawnSpecies} immunised.`, 'discovery');
        }],
      ]),
    );
    if (world.disease.history.length) {
      const table = document.createElement('table');
      table.className = 'data';
      table.append(rowOf(['Pathogen', 'Host', 'Day', 'Peak']));
      for (const h of world.disease.history.slice(-6).reverse()) {
        table.append(rowOf([h.name, h.species, String(h.day), `${(h.peak * 100).toFixed(0)}%`]));
      }
      disease.append(table);
    }
    body.append(disease);
    void HostClass;
  }

  /* ------------------------------------------------------------------ */
  /* Simulation counters                                                 */
  /* ------------------------------------------------------------------ */

  private renderStats(): void {
    const body = this.rightBody;
    const world = this.host.world;
    const feed = this.host.feed;
    body.replaceChildren();
    const perf = el('div', 'section');
    perf.append(sectionTitle('Engine'));
    const grid = el('div', 'grid2');
    grid.append(
      stat('Sim ms/step', world.stats.simMs.toFixed(2)),
      stat('Steps/frame', String(world.stats.stepsThisFrame)),
      stat('Animals', String(world.stats.creatures)),
      stat('Sim min/s', Math.round(world.stats.simMinutesPerSecond).toString()),
      stat('Trees', String(world.stats.trees)),
      stat('Errors', String(world.errors.length)),
    );
    perf.append(grid);
    body.append(perf);

    const eating = el('div', 'section');
    eating.append(sectionTitle('Feeding, measured'));
    const table = document.createElement('table');
    table.className = 'data';
    table.append(rowOf(['Species', 'Meals']));
    for (const [key, value] of Object.entries(feed.perSpecies).sort((a, b) => b[1] - a[1])) {
      table.append(rowOf([SPECIES[speciesIndex(key)]?.name ?? key, value.toFixed(1)]));
    }
    eating.append(table);
    const kinds = el('div', 'grid2');
    kinds.append(
      stat('Plants', feed.plants.toFixed(1)),
      stat('Insects & mice', feed.insects.toFixed(1)),
      stat('Meat', feed.meat.toFixed(1)),
      stat('Carrion', feed.carrion.toFixed(1)),
      stat('Fish', feed.fish.toFixed(1)),
      stat('Feed events', String(feed.calls)),
      stat('Kills', String(feed.kills)),
      stat('Attacks', String(feed.attacks)),
      stat('Prey sightings', String(feed.sightings)),
    );
    eating.append(kinds);
    body.append(eating);

    const world2 = el('div', 'section');
    world2.append(sectionTitle('Environment'));
    const env = el('div', 'grid2');
    env.append(
      stat('Land water', compact(world.hydrology.landWaterVolume)),
      stat('Snow', compact(world.hydrology.snowVolume)),
      stat('Soil moisture', world.terrain.soilMoisture.stats().mean.toFixed(3)),
      stat('Fertility', world.terrain.fertility.stats().mean.toFixed(3)),
      stat('Grass cover', world.vegetation.layer('grass').stats().mean.toFixed(3)),
      stat('Shrub cover', world.vegetation.layer('shrub').stats().mean.toFixed(3)),
      stat('Canopy', world.terrain.canopy.stats().mean.toFixed(3)),
      stat('Detritus', world.terrain.detritus.stats().mean.toFixed(3)),
    );
    world2.append(env);
    body.append(world2);

    const agg = el('div', 'section');
    agg.append(sectionTitle('Patch populations'));
    const aggTable = document.createElement('table');
    aggTable.className = 'data';
    aggTable.append(rowOf(['Guild', 'Biomass', 'Trend']));
    for (const s of world.aggregates.species) {
      const stat0 = world.aggregates as unknown as { total: (k: string) => number; relative: (k: string) => number };
      aggTable.append(rowOf([s.name, compact(stat0.total(s.key)), `${(stat0.relative(s.key) * 100).toFixed(0)}%`]));
    }
    agg.append(aggTable);
    body.append(agg);
  }
}

/* ------------------------------------------------------------------ */
/* Chart helpers                                                       */
/* ------------------------------------------------------------------ */

function lineChart(series: { day: number; value: number }[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = '100%';
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (series.length < 2) {
    ctx.fillStyle = 'rgba(107,117,124,0.8)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('not enough samples yet', 8, height / 2);
    return canvas;
  }
  const vmax = Math.max(...series.map((s) => s.value), 1);
  const dmin = series[0].day;
  const dmax = Math.max(series[series.length - 1].day, dmin + 1);
  ctx.strokeStyle = 'rgba(120,132,140,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();
  ctx.beginPath();
  series.forEach((s, i) => {
    const x = ((s.day - dmin) / (dmax - dmin)) * (width - 4) + 2;
    const y = height - 4 - (s.value / vmax) * (height - 12);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(200,135,60,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const last = series[series.length - 1];
  ctx.fillStyle = 'rgba(232,228,218,0.9)';
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(last.value.toFixed(0), width - 26, 10);
  ctx.fillStyle = 'rgba(107,117,124,0.9)';
  ctx.fillText(`D${Math.round(dmin)}`, 2, height - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`D${Math.round(last.day)}`, width - 2, height - 3);
  ctx.textAlign = 'left';
  return canvas;
}

function populationOf(world: SimHost['world'], key: string): number {
  const stat = world.census.get(key);
  if (stat) return stat.count;
  const n = (world.aggregates as unknown as { total: (k: string) => number }).total(key);
  return Math.round(n);
}

function maxGeneration(world: SimHost['world']): number {
  let max = 0;
  for (const s of SPECIES) max = Math.max(max, world.census.get(s.key)?.maxGeneration ?? 0);
  return max;
}

function strikeCentre(world: SimHost['world'], kind: 'fire' | 'wildfire' | 'meteor' | 'quake' | 'flood' | 'disease'): void {
  const cx = world.terrain.worldToCellX(0);
  const cy = world.terrain.worldToCellY(0);
  switch (kind) {
    case 'fire':
      world.fire.strike(Math.round(cx), Math.round(cy));
      break;
    case 'wildfire':
      world.fire.ignite(Math.round(cx), Math.round(cy), 1.4);
      break;
    case 'meteor':
      world.meteorStrike(0, 0, 40);
      break;
    case 'quake':
      world.earthquake(0, 0, 0.7);
      break;
    case 'flood':
      world.floodAt(0, 0, 60, 0.9);
      break;
    case 'disease':
      world.disease.release(0, world.clock.day);
      break;
  }
}

function strikeCentreWithSpecies(world: SimHost['world'], key: string, count: number, vegetation = false): void {
  if (vegetation) {
    world.sowAt(0, 0, 60, 0, 0.4);
    return;
  }
  world.introduceSpecies(key, 0, 0, count || 6);
}

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function panel(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'panel');
  const head = el('div', 'panel-head');
  const h = document.createElement('h2');
  h.textContent = title;
  head.append(h);
  const body = el('div', 'panel-body');
  root.append(head, body);
  return { root, body };
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function span2(className: string, text: string): HTMLElement {
  const node = el('span', className);
  node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  const node = el('div', 'section');
  const h = document.createElement('h3');
  h.textContent = text;
  node.append(h);
  return node;
}

function stat(k: string, v: string): HTMLElement {
  const row = el('div', 'stat');
  row.append(span2('k', k), span2('v', v));
  return row;
}

function meter(label: string, value: number, invert = false, tone = ''): HTMLElement {
  const row = el('div', 'meter');
  row.append(span2('small dim', label));
  const m = el('div', 'm');
  const i = el('i');
  const v = clamp01(value);
  i.style.width = `${(invert ? v : v) * 100}%`;
  if (tone) i.classList.add(tone);
  else if (invert ? v > 0.75 : v < 0.3) i.classList.add('bad');
  else if (invert ? v > 0.5 : v < 0.55) i.classList.add('warn');
  m.append(i);
  const text = el('div', 'v');
  text.textContent = value.toFixed(2);
  row.append(m, text);
  return row;
}

function meterBar(value: number, tone = ''): HTMLElement {
  const bar = el('div', 'bar');
  const i = el('i', tone);
  i.style.width = `${clamp01(value) * 100}%`;
  bar.append(i);
  return bar;
}

function chip(text: string, hot = false): HTMLElement {
  const c = el('span', `chip${hot ? ' hot' : ''}`);
  c.textContent = text;
  return c;
}

function hint(text: string): HTMLElement {
  const p = el('div', 'small faint');
  p.textContent = text;
  p.style.padding = '4px 0';
  return p;
}

function buttonRow(buttons: [string, () => void][], small = false): HTMLElement {
  const row = el('div', 'row tight wrap');
  for (const [label, run] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn${small ? ' small' : ''}`;
    b.textContent = label;
    b.addEventListener('click', run);
    row.append(b);
  }
  return row;
}

function th(text: string): HTMLElement {
  const node = document.createElement('th');
  node.textContent = text;
  return node;
}

function td(text: string, plain = false): HTMLElement {
  const node = document.createElement('td');
  if (plain) node.className = 'text';
  node.textContent = text;
  return node;
}

function rowOf(cells: string[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  cells.forEach((c, i) => tr.append(i === 0 ? td(c, true) : td(c)));
  return tr;
}

function trait(p: NonNullable<ReturnType<SimHost['profile']>>, key: string): string {
  return p.traits.find((t) => t.key === key)?.value.toFixed(3) ?? '—';
}

function litterOf(key: string): string {
  const sp = SPECIES[speciesIndex(key)];
  if (!sp) return '—';
  return `${sp.litterSize[0]}–${sp.litterSize[1]}`;
}

function describeDiet(sp: (typeof SPECIES)[number]): string {
  const labels = ['grass', 'shrubs', 'reeds', 'algae', 'moss', 'desert plants'];
  const eaten = sp.plantDiet.map((v, i) => (v > 0.15 ? labels[i] : null)).filter((x): x is string => Boolean(x));
  const parts = [...eaten];
  if (sp.aggregatePrey.length) parts.push(sp.aggregatePrey.join(', '));
  if (!parts.length) parts.push('animal prey');
  return parts.join(', ');
}

function compact(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

void MemKind;
void Action;
void TIME;
void HostClass;
