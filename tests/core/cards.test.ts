import { describe, expect, it } from 'vitest';
import { checkCard, parseBrief, parseCards, type CardReply, type CardRules } from '../../src/core/cards.ts';
import { loadTargetLanguage } from '../../src/core/language.ts';

// 文字都是這裡編的（ADR-0118）。

const { profile } = loadTargetLanguage('zh-TW');
const RULES: CardRules = {
  classes: new Set(['person', 'place', 'deity']),
  pronouns: new Set(profile.pronouns),
  script: profile.script_check,
};

function card(id: string, target: string, attributes = ''): CardReply {
  return { kind: 'card', id, raw: '', target, attributes };
}

describe('parseCards', () => {
  it('reads cards and skips by id, and keeps the raw element', () => {
    const { replies, broken } = parseCards(
      '<card id="1" class="place">鹽沼</card>\n<skip id="2"/>\n<card id="3" gender="female" pronoun="她">艾妲</card>',
    );
    expect(broken.size).toBe(0);
    expect(replies.get('1')).toEqual({
      kind: 'card',
      id: '1',
      raw: '<card id="1" class="place">鹽沼</card>',
      target: '鹽沼',
      attributes: ' id="1" class="place"',
    });
    expect(replies.get('2')).toEqual({ kind: 'skip', id: '2', raw: '<skip id="2"/>' });
    expect(replies.get('3')?.kind).toBe('card');
  });

  it('unescapes the translation and keeps the first of two with the same id', () => {
    const { replies } = parseCards('<card id="1">甲 &amp; 乙</card><card id="1">丙</card>');
    expect(replies.get('1')).toMatchObject({ target: '甲 & 乙' });
  });

  it('counts a card with a tag inside, or one never closed, as not received', () => {
    const { replies, broken } = parseCards('<card id="1">甲<b>乙</b></card><card id="2">丙</card><card id="3">丁');
    expect([...broken].sort()).toEqual(['1', '3']);
    expect([...replies.keys()]).toEqual(['2']);
  });

  it('ignores text and tags outside a card, and elements with no id', () => {
    const { replies } = parseCards('Here you go:\n<card>甲</card><note id="9">x</note><skip id="4"/>');
    expect([...replies.keys()]).toEqual(['4']);
  });

  it('reads a long reply in time proportional to its length', () => {
    const reply = '<card id="1">'.repeat(20000);
    const started = performance.now();
    parseCards(reply);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('checkCard', () => {
  it('keeps the attributes it can trust', () => {
    const checked = checkCard(card('1', '艾妲', ' class="person" gender="female" pronoun="她" register="formal" keep="source"'), RULES);
    expect(checked).toEqual({
      ok: true,
      card: { target: '艾妲', class: 'person', gender: 'female', pronoun: '她', register: 'formal', keep_source: true },
      dropped: [],
    });
  });

  it('drops an unknown class, gender or pronoun and says which, without a resend', () => {
    const checked = checkCard(card('1', '鹽沼', ' class="swamp" gender="maybe" pronoun="伊"'), RULES);
    expect(checked).toEqual({ ok: true, card: { target: '鹽沼', keep_source: false }, dropped: ['class', 'gender', 'pronoun'] });
  });

  it('resends an empty translation or one in simplified characters', () => {
    expect(checkCard(card('1', ''), RULES)).toEqual({ ok: false, reason: 'empty' });
    // 簡體的「鹽」用碼位寫，repo 裡不放簡體字。
    expect(checkCard(card('1', `${String.fromCodePoint(0x76d0)}沼`), RULES)).toEqual({ ok: false, reason: 'script_mixed' });
  });
});

describe('parseBrief', () => {
  it('reads the three parts', () => {
    const reply = 'Sure.\n<brief>\n<era>Iron age marsh &amp; fens.</era>\n<tone>Grim.</tone>\n<factions>Wardens.</factions>\n</brief>';
    expect(parseBrief(reply)).toEqual({
      brief: { era: 'Iron age marsh & fens.', tone: 'Grim.', factions: 'Wardens.' },
      raw: '<brief>\n<era>Iron age marsh &amp; fens.</era>\n<tone>Grim.</tone>\n<factions>Wardens.</factions>\n</brief>',
    });
  });

  it('refuses a brief with a part missing or empty', () => {
    expect(parseBrief('<brief><era>x</era><tone>y</tone></brief>')).toBeNull();
    expect(parseBrief('<brief><era>x</era><tone> </tone><factions>z</factions></brief>')).toBeNull();
    expect(parseBrief('no brief here')).toBeNull();
  });
});
