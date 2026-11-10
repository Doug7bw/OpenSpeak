import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildCode, encodeHeroBuild, zstdRawFrame } from '../src/buildcode.js';
import { DeadlockData, counters, heroSummary, normalize, rankBuilds, wilsonLower } from '../src/deadlock.js';
import { abilityOrder, categoryName, renderBuild, renderCode, renderNotes } from '../src/dlview.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/build-722319-v740.json', import.meta.url), 'utf8'))[0];

// Código exportado pelo próprio jogo para essa mesma build (versão 740): importa no jogo.
const GAME_CODE = 'KLUv/UQ41AYlLAB6UTgSLeC44cit6Nup7u/UepmtYI/8qvtfg3dYWuvbOvEoDa11/y+K9P/CFlkovK+WDgwBHgEXAWhXA6xrcba1ubtdzMVJvf1+LYY6yq3d5q4WM0XFdFH+rhROe9JrcVE7baU6pZvNYqJewkw9Ng8MW62Ai1ce7IBmoh7i1QAr0IZdmOMBoCngZAFAEZHKZmxkxPTTIlp/8u5I17dcTxpJ6T7+bvtTznbfkYyciNq7OImpkz5DtRtlJ6TOZp1kWuRzSzkR9fZbKgmqjbS4tZ4E1dpt+2+1rVSUnZoaN3d71Ev+uaW0uLn+tE1qMqrNXsL+7UnfUkRt5I+5TkVtlM1ORK31J+8JMCxBQhIxcqWibdYIu1GHdIxPC06Nz81P88Ts/PQ0TE5L99zctLg0TstOT4iHAeViFmIXeHK6vRMCDiBdYNcPDwpjYmyRVwps/qwTxANB35yn2bUCa6RtiXhY2MSEU7xaYA8osQQbObAvH5joVQF7kCnnR3c1wA4UrsFdC7BDIUMPDwKPdKdpVwpswBs2gOTlEoChk89S7WqA7X43d7t4pJvNZqU+2vZvs417iYuPevuNpM1bpHYuVtLmpP/cSV0nnpaHhD5Uz9JrDRZr6LaHdTXAdrEvHgAAITBXFoCMGJyWmRa64WmJwT7446X8WadPQspH2m1/EWZayu1ITklZ7EmdX4vbaLud6TGqzXbu9oXmAaESktHquoMdWCXNVONwJLyEjbROR42UXVoEKbtcPAh4an5qXT+wSUg5qbtKRfi7zXXaSjWTu1Jvv52bZS4erquakmHXDOzAYuNXIUdZ7zIhabPSdptt526E9A5NI2kz15+2Rc5tqayRFocY5aVG0uau02PnzgRUPRhUVv3lXQO4sAN6clqoVwMsFow07upqgPWn3O3ipcaNpM1POKmfi7/b2WyGahDnOnW3TFExjaTNj7O4qBvTRlrczUnf/p5lWtp6kVZH+4CAx/cleH3COnf7QvCQgFZHmnVVwAo4YgNIXtioHhIqHQ+/rhLY73KdiPozNzN1uwvU8HDVolzEukpgtVBbI6WirVYpm92Q8qRvqK1WqZ22QhgPC6Z3rKpXDaxRa7dM2KFGfArTtCvlbPd3tRkj4X6tZ7NeFBVz8lAgRviGdl3BBuBhX9ioYGpwrg/abf4iJyPnthZqa5TdbosCSUEIeHxfgkEJaHWkWUEB7/u+7/u+qxMBhO/7vm/rRADh+77vuzoR4PC+7/u2TgQ4EDo4vO/7vqvv+75vKwGVXx5hQMD7vu/7vu87IeAgUPVFuXiFwAo0PgSQvLBRCaTadZJeDbANZoOhclcD7AJV5tnb1QB7hZtk7LoaYDu6Xc+fs/mdmps96VupyJOKOLqzWLvNj50+93SIyoMAYVmp2DUGy/Wu05G2po+2rQ3prPeEPAysjXJpXk2wRv5MTlyuvzY3kjY7US9tuUf9uV/rT85l6u13DI+OTIzL46f8RS04DwqBomVh1x+sgBf2hY0qxqflBuEhiz1JiusU5XTT8BDgBmpVdpXAGmH/rjZ3UpH7DQiSNmexJwVaqBJ0AkOYIQQZQwghAiJDdNQDElBwMCh4UH0SKLi1UoGQFJnmxYMkM/4nCilB3S/Ouh30p4xQgDlkp6tKMQQrELDSsuHwMqB4UjUgOvbkFz6vZUIgbfPThHG0Z4YiuMEpCNp15NhWMSq0bogvTUsuMWh5d0q9foNbTvpJa/TrwHPw0x+60bkoPWEKWYlV0LdMywszxKSmJ24imvEShyB/7AaT58UqtStblkqISXDhCCJHZX0dGsX2o/8AdRE9wIEiADrgioUaZjmZnVyBrdvl0SbACj1UHXimGa2qXamTCk17xmiZcu2sa9dF6tfxXDLSCq5E9nU=';

const zstdNative = typeof zlib.zstdDecompressSync === 'function';

test('gera exatamente o protobuf que o jogo exporta', { skip: !zstdNative && 'Node sem zstd' }, () => {
  const fromGame = zlib.zstdDecompressSync(Buffer.from(GAME_CODE, 'base64'));
  assert.equal(Buffer.compare(encodeHeroBuild(fixture.hero_build), fromGame), 0);
});

test('código abre de volta (zstd normal e o quadro "raw" do plano B)', { skip: !zstdNative && 'Node sem zstd' }, () => {
  const proto = encodeHeroBuild(fixture.hero_build);
  assert.equal(Buffer.compare(zlib.zstdDecompressSync(Buffer.from(buildCode(fixture.hero_build), 'base64')), proto), 0);
  for (const size of [10, 300, 70000]) {
    const data = Buffer.alloc(size, 7);
    assert.equal(Buffer.compare(zlib.zstdDecompressSync(zstdRawFrame(data)), data), 0, `raw ${size} B`);
  }
});

test('sem ID de build, o código ganha um ID ≠ 0 (o jogo recusa sem)', () => {
  const proto = encodeHeroBuild({ ...fixture.hero_build, hero_build_id: undefined });
  assert.deepEqual([...proto.subarray(0, 2)], [0x08, 0x01]); // campo 1 = 1
});

test('normalize e Wilson', () => {
  assert.equal(normalize('Mo & Krill'), 'mokrill');
  assert.equal(normalize('Dínamo'), 'dinamo');
  assert.ok(wilsonLower(58, 100) < wilsonLower(5800, 10000)); // mais partidas, mais confiança
  assert.equal(wilsonLower(0, 0), 0);
});

const items = new Map([[1, { shopable: true, name: 'A', slot: 'weapon' }], [2, { shopable: true, name: 'B', slot: 'spirit' }], [3, { shopable: false, name: 'Velho', slot: 'vitality' }]]);
const mkBuild = (id, mods, language = 0) => ({ hero_build: { hero_build_id: id, language, details: { mod_categories: [{ mods }] } } });

test('rankBuilds: win rate com confiança, anotadas na frente, idioma e itens removidos pesam', () => {
  const stats = [
    { hero_build_id: 10, matches: 10000, wins: 5600 }, // 56% sem anotações
    { hero_build_id: 11, matches: 10000, wins: 5590 }, // 55,9% anotada: passa na frente
    { hero_build_id: 12, matches: 300, wins: 200 }, // 66%, mas poucas partidas (abaixo de 5% do topo)
    { hero_build_id: 13, matches: 9000, wins: 5400 }, // 60%, mas em russo
    { hero_build_id: 14, matches: 9000, wins: 5300 }, // 58,9%, com item que saiu do jogo
  ];
  const builds = new Map([
    [10, mkBuild(10, [{ ability_id: 1 }, { ability_id: 2 }])],
    [11, mkBuild(11, [{ ability_id: 1, annotation: 'compre cedo' }, { ability_id: 2, annotation: 'depois' }])],
    [12, mkBuild(12, [{ ability_id: 1 }])],
    [13, mkBuild(13, [{ ability_id: 1 }], 8)],
    [14, mkBuild(14, [{ ability_id: 3 }, { ability_id: 1 }])],
  ]);
  const ranked = rankBuilds(stats, builds, items, { minMatches: 200 });
  assert.deepEqual(ranked.map(r => r.id), [11, 10, 14, 13]);
  assert.equal(ranked.find(r => r.id === 14).removed, 1);
  assert.equal(ranked.find(r => r.id === 13).readable, false);
});

test('counters: quem ganha do herói e de quem ele ganha, só com partidas suficientes', () => {
  const rows = [
    { hero_id: 5, enemy_hero_id: 72, wins: 600, matches_played: 1000 },
    { hero_id: 6, enemy_hero_id: 72, wins: 520, matches_played: 1000 },
    { hero_id: 7, enemy_hero_id: 72, wins: 9, matches_played: 10 }, // poucas partidas
    { hero_id: 72, enemy_hero_id: 5, wins: 400, matches_played: 1000 },
    { hero_id: 72, enemy_hero_id: 8, wins: 570, matches_played: 1000 },
  ];
  const c = counters(rows, 72);
  assert.deepEqual(c.beatenBy.map(x => x.heroId), [5, 6]);
  assert.deepEqual(c.beats.map(x => x.heroId), [8, 5]);
});

test('heroSummary: win rate, pick rate e posição', () => {
  const rows = [
    { hero_id: 1, wins: 60, matches: 100, total_kills: 700, total_deaths: 500, total_assists: 900 },
    { hero_id: 2, wins: 45, matches: 100, total_kills: 1, total_deaths: 1, total_assists: 1 },
  ];
  const s = heroSummary(rows, 2);
  assert.equal(s.position, 2);
  assert.equal(s.winRate, 0.45);
  assert.equal(s.pickRate, 100 / (200 / 12));
  assert.equal(heroSummary(rows, 99), null);
});

const hero = {
  id: 2, name: 'Seven', namePt: 'Sete', icon: null, card: null,
  abilities: new Map([[1074714947, { slot: 2, name: 'Static Charge' }], [539192269, { slot: 3, name: 'Power Surge' }],
    [1065103387, { slot: 1, name: 'Lightning Ball' }], [2061574352, { slot: 4, name: 'Storm Cloud' }]]),
};

test('categorias e ordem de habilidades legíveis', () => {
  assert.equal(categoryName('#Citadel_HeroBuilds_EarlyGame'), 'Early game');
  assert.equal(categoryName('Defensive Core'), 'Defensive Core');
  const order = abilityOrder(fixture.hero_build, hero);
  assert.match(order, /^Desbloqueio: /);
  assert.match(order, /\*\*1\*\* Lightning Ball/);
});

test('telas do /build, código e anotações dentro dos limites do Discord', () => {
  const allItems = new Map(fixture.hero_build.details.mod_categories.flatMap(c => c.mods)
    .map(m => [m.ability_id, { name: `Item ${m.ability_id}`, slot: 'spirit', shopable: true, cost: 800 }]));
  const ranked = rankBuilds([{ hero_build_id: 722319, matches: 1000, wins: 550 }], new Map([[722319, fixture]]), allItems, { minMatches: 10 });
  const msg = renderBuild({ hero, rank: 'todos', ranked, items: allItems });
  const embed = msg.embeds[0].toJSON();
  assert.equal(embed.title, fixture.hero_build.name);
  for (const f of embed.fields) assert.ok(f.value.length <= 1024);
  msg.components.forEach(r => r.toJSON());
  assert.equal(renderBuild({ hero, rank: 'todos', ranked: [], items: allItems }).components.length, 0);

  const short = renderCode({ hero, build: fixture.hero_build, code: 'KLUv'.repeat(10) });
  assert.equal(short.content.length, 40);
  const long = renderCode({ hero, build: fixture.hero_build, code: 'A'.repeat(2500) });
  assert.equal(long.files.length, 1);

  const notes = renderNotes({ build: fixture.hero_build, items: allItems });
  for (const m of notes) {
    const json = m.embeds.map(e => e.toJSON());
    assert.ok(json.length <= 10);
    assert.ok(json.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.author?.name?.length ?? 0), 0) <= 6000);
  }
});

test('findHero aceita nome em inglês, português, apelido e ID', async () => {
  const assets = {
    heroes_en: [{ id: 2, name: 'Seven', class_name: 'hero_gigawatt', player_selectable: true, images: {}, items: {} },
      { id: 18, name: 'Mo & Krill', class_name: 'hero_krill', player_selectable: true, images: {}, items: {} }],
    heroes_pt: [{ id: 2, name: 'Sete' }, { id: 18, name: 'Mo e Krill' }],
  };
  const fetchImpl = async url => ({
    ok: true, status: 200, headers: new Map(),
    json: async () => (url.includes('/heroes') ? (url.includes('brazilian') ? assets.heroes_pt : assets.heroes_en) : []),
  });
  const d = new DeadlockData({ fetchImpl });
  assert.equal((await d.findHero('sete')).id, 2);
  assert.equal((await d.findHero('SEVEN')).id, 2);
  assert.equal((await d.findHero('gigawatt')).id, 2);
  assert.equal((await d.findHero('mo')).id, 18);
  assert.equal((await d.findHero('18')).id, 18);
  assert.equal(await d.findHero('zzz'), null);
  assert.deepEqual((await d.heroChoices('set')).map(c => c.name), ['Seven (Sete)']);
});

test('build muito anotada: texto leva o código sem anotações e o arquivo, o completo', async () => {
  const { withoutAnnotations } = await import('../src/dlview.js');
  const lite = withoutAnnotations(fixture.hero_build);
  assert.ok(lite.details.mod_categories.every(c => c.mods.every(m => !m.annotation)));
  assert.equal(lite.details.mod_categories.flatMap(c => c.mods).length, fixture.hero_build.details.mod_categories.flatMap(c => c.mods).length);
  assert.ok(fixture.hero_build.details.mod_categories[0].mods.some(m => m.annotation)); // o original continua intacto
  const msg = renderCode({ hero, build: fixture.hero_build, code: 'A'.repeat(2500), lite: 'KLUv' });
  assert.equal(msg.content, 'KLUv');
  assert.equal(msg.files.length, 1);
});

test('build publicada mostra o ID (sem botão de código); sem ID, o botão do código', () => {
  const allItems = new Map();
  const mk = id => rankBuilds([{ hero_build_id: 5, matches: 1000, wins: 550 }],
    new Map([[5, { hero_build: { ...fixture.hero_build, hero_build_id: id } }]]), allItems, { minMatches: 10 });
  const published = renderBuild({ hero, rank: 'todos', ranked: mk(722319), items: allItems });
  assert.ok(published.embeds[0].toJSON().fields.some(f => f.value.includes('722319')));
  assert.ok(!published.components.at(-1).toJSON().components.some(c => /^dl:(id|code):/.test(c.custom_id ?? '')));
  const unpublished = renderBuild({ hero, rank: 'todos', ranked: mk(0), items: allItems });
  assert.match(unpublished.components.at(-1).toJSON().components[0].custom_id, /^dl:code:/);
});

test('imagem da build: PNG com as seções na ordem do jogo; sem ícone, iniciais', async () => {
  const { renderBuildImage, layoutSections, imageHeight } = await import('../src/buildimage.js');
  const sections = layoutSections(fixture.hero_build);
  assert.equal(sections.length, fixture.hero_build.details.mod_categories.filter(c => c.mods?.length).length);
  assert.ok(imageHeight(sections) > 200);
  const items = new Map(fixture.hero_build.details.mod_categories.flatMap(c => c.mods)
    .map(m => [m.ability_id, { name: 'Item Teste', slot: 'weapon', cost: 800, shopable: true, image: 'https://x/icone.png' }]));
  const png = await renderBuildImage({ build: fixture.hero_build, items, fetchImpl: async () => ({ ok: false }) });
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  assert.equal(await renderBuildImage({ build: { details: { mod_categories: [] } }, items }), null);

  const ranked = rankBuilds([{ hero_build_id: 722319, matches: 1000, wins: 550 }], new Map([[722319, fixture]]), items, { minMatches: 10 });
  const msg = renderBuild({ hero, rank: 'todos', ranked, items, image: png });
  const embed = msg.embeds[0].toJSON();
  assert.equal(embed.image.url, 'attachment://build.png');
  assert.equal(msg.files.length, 1);
  assert.ok(!embed.fields.some(f => f.name === 'Early game')); // itens só na imagem
  const sem = renderBuild({ hero, rank: 'todos', ranked, items });
  assert.ok(sem.embeds[0].toJSON().fields.some(f => f.value.includes('Item Teste'))); // sem imagem: lista em texto
});
