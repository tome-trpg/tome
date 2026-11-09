import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTargetLanguage, scriptViolations } from '../../src/core/language.ts';
import { maskText, type MaskRange } from '../../src/core/mask.ts';
import { loadPhraseCheck, type PhraseCheck } from '../../src/core/opencc.ts';
import type { LocalizedTerm } from '../../src/core/pack.ts';
import { parseUnits } from '../../src/core/tags.ts';
import type { EntityCard } from '../../src/core/entities.ts';
import { bookTerms, hitTerms, humanProblems, matchUnits, verifyFragment, type VerifyContext } from '../../src/core/verify.ts';

// 文字都是這裡編的，跟任何書都沒有關係。

const { profile } = loadTargetLanguage('zh-TW');

function unit(source: string, ranges: readonly MaskRange[] = [], role = 'paragraph') {
  return { source, role, ...maskText(source, ranges) };
}

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return { language: profile, terms: [], phraseCheck: () => [], ...overrides };
}

function term(text: string, target: string, extra: Partial<LocalizedTerm['term']> = {}): LocalizedTerm {
  return { text, term: { source: { en: text }, target, ...extra } };
}

function codes(result: { problems: readonly { code: string }[] }): string[] {
  return result.problems.map(({ code }) => code);
}

const LONG_SOURCE = 'The warden counts the tide stones before each crossing and marks a lantern.';
const LONG_TRANSLATION = '守望者在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起。';

describe('a good translation', () => {
  it('passes, and comes back formatted and restored', () => {
    const source = 'Roll 1D100, then rest for the whole night by the old ferry.';
    const verdict = verifyFragment(
      unit(source, [{ start: 5, end: 10, kind: 'dice' }]),
      '<s id="1">擲 <ph id="1"/>,然後在老渡口過夜休息,等待天亮再出發。</s>',
      context(),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.translation).toBe('擲1D100，然後在老渡口過夜休息，等待天亮再出發。');
  });
});

describe('inline styles (ADR-0116)', () => {
  const styled = {
    source: LONG_SOURCE,
    role: 'paragraph',
    ...maskText(LONG_SOURCE, [], [{ start: 4, end: 10, marks: ['bold'] }]),
  };

  it('passes when every <pc> comes back, and says where it landed after formatting', () => {
    const verdict = verifyFragment(styled, '<s id="1"><pc id="1">守望者</pc> 在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起。</s>', context());
    expect(verdict.passed).toBe(true);
    expect(verdict.translation).toBe('守望者 在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起。');
    expect(verdict.paired).toEqual([{ id: 1, start: 0, end: 3 }]);
  });

  it('resends a reply that lost a <pc>, and has no offsets', () => {
    const verdict = verifyFragment(styled, `<s id="1">${LONG_TRANSLATION}</s>`, context());
    expect(codes(verdict)).toContain('placeholder_mismatch');
    expect(verdict.passed).toBe(false);
    expect(verdict.paired).toEqual([]);
  });
});

describe('the protocol', () => {
  it('fails a reply that does not parse', () => {
    const verdict = verifyFragment(unit(LONG_SOURCE), `<s id="1">${LONG_TRANSLATION}<b></s>`, context());
    expect(codes(verdict)).toContain('tag_error');
    expect(verdict.passed).toBe(false);
    expect(verdict.translation).toBeNull();
  });

  it.each([
    ['nothing', ''],
    ['two units', '<s id="1">甲</s><s id="2">乙</s>'],
  ])('fails %s where one unit was expected', (_name, fragment) => {
    expect(codes(verifyFragment(unit(LONG_SOURCE), fragment, context()))).toEqual(['unit_missing']);
  });

  it('matches units one to one, and names what is missing or extra', () => {
    const reply = parseUnits('<s id="1">甲</s><s id="3">丙</s>');
    const { matched, missing, extra } = matchUnits(reply, ['1', '2']);
    expect([...matched.keys()]).toEqual(['1']);
    expect(missing).toEqual(['2']);
    expect(extra).toEqual(['3']);
  });

  it('counts a unit written twice as one and an extra', () => {
    const reply = parseUnits('<s id="1">甲</s><s id="1">乙</s>');
    const { matched, extra } = matchUnits(reply, ['1']);
    expect(matched.size).toBe(1);
    expect(extra).toEqual(['1']);
  });
});

describe('placeholders', () => {
  const dice = unit('Roll 1D6 and 1D8 by the old ferry until the morning bell.', [
    { start: 5, end: 8, kind: 'dice' },
    { start: 13, end: 16, kind: 'dice' },
  ]);
  const padding = '在老渡口一直擲到晨鐘響起為止';

  it('wants each one exactly once, in any order', () => {
    const fragment = `<s id="1"><ph id="2"/>與<ph id="1"/>${padding}。</s>`;
    expect(codes(verifyFragment(dice, fragment, context()))).toEqual([]);
  });

  it.each([
    ['a lost one', `<s id="1"><ph id="1"/>${padding}。</s>`],
    ['a repeated one', `<s id="1"><ph id="1"/><ph id="1"/><ph id="2"/>${padding}。</s>`],
    ['an invented one', `<s id="1"><ph id="1"/><ph id="2"/><ph id="3"/>${padding}。</s>`],
  ])('fails %s', (_name, fragment) => {
    const verdict = verifyFragment(dice, fragment, context());
    expect(codes(verdict)).toContain('placeholder_mismatch');
    expect(verdict.translation).toBeNull();
  });

  it('finds them inside the tags that only carry a note', () => {
    const fragment = `<s id="1"><new-term source="x"><ph id="1"/></new-term><ph id="2"/>${padding}。</s>`;
    expect(codes(verifyFragment(dice, fragment, context()))).toEqual(['new_term']);
  });
});

describe('numbers (ADR-0102)', () => {
  const check = (source: string, translation: string): string[] =>
    codes(verifyFragment(unit(source), `<s id="1">${translation}</s>`, context())).filter((code) =>
      code.startsWith('number_'),
    );

  it('passes the same numbers', () => {
    expect(check('Pay 12 coins and 3 pearls.', '支付 12 枚硬幣與 3 顆珍珠。')).toEqual([]);
  });

  it('fails a changed or lost number', () => {
    expect(check('Pay 12 coins.', '支付 13 枚硬幣。')).toContain('number_missing');
    expect(check('Pay 12 coins.', '支付硬幣。')).toEqual(['number_missing']);
  });

  it('wants a repeated number as often as the source has it', () => {
    expect(check('Roll 6 or 6 again.', '再擲一次 6。')).toEqual(['number_missing']);
  });

  it('only reports a number the translation added, since three may become 3', () => {
    expect(check('Pay three coins.', '支付 3 枚硬幣。')).toEqual(['number_extra']);
  });

  it('reads a thousands comma as part of the number', () => {
    expect(check('Pay 1,000 coins.', '支付 1000 枚硬幣。')).toEqual([]);
    expect(check('Pay 1000 coins.', '支付 1,000 枚硬幣。')).toEqual([]);
    expect(check('Pay 1,234,567 coins.', '支付 1234567 枚硬幣。')).toEqual([]);
  });

  it('reads any other comma as a separator', () => {
    expect(check('Roll 1,2,3 on the die.', '擲出 1、2、3。')).toEqual([]);
    expect(check('Rows 10,20 stay.', '第 10、20 列保留。')).toEqual([]);
  });

  it('keeps decimals whole', () => {
    expect(check('A 1.5 metre rope.', '一條 1.5 公尺的繩子。')).toEqual([]);
    expect(check('A 1.5 metre rope.', '一條 15 公尺的繩子。')).toContain('number_missing');
  });

  it('counts full-width digits', () => {
    expect(check('Pay 12 coins.', '支付１２枚硬幣。')).toEqual([]);
  });

  it('does not compare numbers in words', () => {
    expect(check('Pay three coins.', '支付三枚硬幣。')).toEqual([]);
  });

  it('ignores what the placeholders hide', () => {
    const masked = unit('Roll 1D100.', [{ start: 5, end: 10, kind: 'dice' }]);
    const verdict = verifyFragment(masked, '<s id="1">擲 <ph id="1"/>。</s>', context());
    expect(codes(verdict)).toEqual([]);
  });
});

describe('locked terms (ADR-0102)', () => {
  const source = 'The Warden lights a lantern at the old ferry before dawn.';
  const translation = '在黎明之前，看守人點亮老渡口的提燈，等候第一班船靠岸。';

  it('wants the locked target of a term the source hits', () => {
    const terms = [term('Warden', '看守人')];
    expect(codes(verifyFragment(unit(source), `<s id="1">${translation}</s>`, context({ terms })))).toEqual([]);
    const other = translation.replace('看守人', '守衛');
    const verdict = verifyFragment(unit(source), `<s id="1">${other}</s>`, context({ terms }));
    expect(verdict.problems).toEqual([
      { code: 'term_missing', level: 'resend', detail: { term: 'Warden', target: '看守人' } },
    ]);
  });

  it('does not count how many times it appears', () => {
    const text = 'The Warden and the Warden and the Warden wait all night at the ferry.';
    const fragment = '<s id="1">看守人整夜都在渡口等候，一步也沒有離開過岸邊。</s>';
    expect(codes(verifyFragment(unit(text), fragment, context({ terms: [term('Warden', '看守人')] })))).toEqual([]);
  });

  it('skips a term the source does not hit', () => {
    const terms = [term('Marsh', '鹽沼')];
    expect(codes(verifyFragment(unit(source), `<s id="1">${translation}</s>`, context({ terms })))).toEqual([]);
  });

  it('follows the match settings', () => {
    const terms = [term('warden', '看守人'), term('Warden', '典獄長', { match: { roles: ['heading'] } })];
    expect(hitTerms(unit(source), terms)).toEqual([]);
    expect(hitTerms(unit(source, [], 'heading'), terms).map(({ text }) => text)).toEqual(['Warden']);
  });

  it('leaves keep_source terms alone, they are hidden', () => {
    const terms = [term('Warden', '看守人', { keep_source: true })];
    expect(hitTerms(unit(source), terms)).toEqual([]);
  });
});

describe('bookTerms: the locked entity cards and the pack terms (ADR-0120)', () => {
  const source = 'The Warden lights a lantern at the old Ferry before dawn.';
  const translation = '在黎明之前，看守人點亮老渡口的提燈，等候第一班船靠岸。';

  function card(source: string, target: string | null, extra: Partial<EntityCard> = {}): EntityCard {
    return {
      id: 1,
      source,
      target,
      class: null,
      gender: null,
      pronoun: null,
      register: null,
      keep_source: false,
      match: null,
      status: 'locked',
      ...extra,
    };
  }

  it('uses only locked cards with a translation; proposals never go into the translation', () => {
    const cards = ['candidate', 'sent', 'proposed', 'skipped', 'failed', 'rejected'].map((status) =>
      card(`Not ${status}`, '甲', { status }),
    );
    expect(bookTerms([], [...cards, card('No Target', null)])).toEqual([]);
    expect(bookTerms([], [card('Salt Marsh', '鹽沼')])).toEqual([{ text: 'Salt Marsh', term: { source: {}, target: '鹽沼' } }]);
  });

  it('prefers the card when a card and a pack term share a source, and keeps the other pack terms after the cards', () => {
    const pack = [term('Warden', '看守人'), term('Ferry', '渡口')];
    const terms = bookTerms(pack, [card('Warden', '守望者')]);
    expect(terms.map(({ text, term: { target } }) => [text, target])).toEqual([
      ['Warden', '守望者'],
      ['Ferry', '渡口'],
    ]);
  });

  it('carries the class, keep_source and the match settings of a card', () => {
    const match = { case_sensitive: false, whole_word: false, roles: ['heading'] };
    const [locked] = bookTerms([], [card('Warden', 'Warden', { class: 'person', keep_source: true, match })]);
    expect(locked?.term).toEqual({ source: {}, target: 'Warden', class: 'person', keep_source: true, match });
  });

  it('adds the gender, pronoun and register only when a card has one of them', () => {
    const [plain] = bookTerms([], [card('Warden', '守望者')]);
    expect(plain).not.toHaveProperty('attributes');
    const [full] = bookTerms([], [card('Warden', '守望者', { gender: 'female', pronoun: '她', register: 'formal' })]);
    expect(full?.attributes).toEqual({ gender: 'female', pronoun: '她', register: 'formal' });
    const [one] = bookTerms([], [card('Warden', '守望者', { register: 'archaic' })]);
    expect(one?.attributes).toEqual({ register: 'archaic' });
  });

  it('gives cards to the verification like pack terms: a hit wants the locked translation, keep_source is hidden', () => {
    const terms = bookTerms([], [card('Warden', '看守人'), card('Ferry', 'Ferry', { id: 2, keep_source: true })]);
    expect(hitTerms(unit(source), terms).map(({ text }) => text)).toEqual(['Warden']);
    const verdict = verifyFragment(unit(source), `<s id="1">${translation.replace('看守人', '守衛')}</s>`, context({ terms }));
    expect(codes(verdict)).toEqual(['term_missing']);
  });

  it('follows the match settings of a card, with the defaults when it has none', () => {
    const lower = bookTerms([], [card('warden', '看守人')]);
    expect(hitTerms(unit(source), lower)).toEqual([]);
    const folded = bookTerms([], [card('warden', '看守人', { match: { case_sensitive: false } })]);
    expect(hitTerms(unit(source), folded).map(({ text }) => text)).toEqual(['warden']);
  });
});

describe('simplified characters (ADR-0102)', () => {
  const fail = (text: string): string[] =>
    codes(verifyFragment(unit(LONG_SOURCE), `<s id="1">${text}</s>`, context())).filter((code) => code === 'script_mixed');

  // 樣本用碼位寫，受版控的文字檔才不用開例外（ADR-0086）。
  const OUTSIDE_BIG5 = String.fromCodePoint(0x8fd9, 0x662f);
  const INSIDE_BIG5 = String.fromCodePoint(0x7136, 0x540e);
  const MISUSED = String.fromCodePoint(0x6a19, 0x51c6);
  const RARE = String.fromCodePoint(0x3402);

  it('fails a form outside Big5, and a form inside it', () => {
    expect(fail(`${LONG_TRANSLATION}${OUTSIDE_BIG5}`)).toEqual(['script_mixed']);
    expect(fail(`${LONG_TRANSLATION}${INSIDE_BIG5}`)).toEqual(['script_mixed']);
  });

  it('fails a misused word', () => {
    expect(fail(`${LONG_TRANSLATION}${MISUSED}`)).toEqual(['script_mixed']);
  });

  it('passes the words that are written this way in Traditional Chinese too', () => {
    expect(fail(`${LONG_TRANSLATION}皇后走到茶几旁`)).toEqual([]);
  });

  it('does not hold a locked target against the translation', () => {
    const target = `看守${RARE}`;
    const terms = [term('Warden', target)];
    const source = 'The Warden counts the tide stones before each crossing and marks a lantern.';
    const verdict = verifyFragment(unit(source), `<s id="1">${LONG_TRANSLATION}${target}</s>`, context({ terms }));
    expect(codes(verdict)).toEqual([]);
    expect(codes(verifyFragment(unit(source), `<s id="1">${LONG_TRANSLATION}${target}</s>`, context()))).toEqual([
      'script_mixed',
    ]);
  });

  it('finds nothing in a long Traditional Chinese text, so a good translation is not sent back', () => {
    const text = [
      '臺灣的皇后走到茶几旁，核准了這份不划算的合約，云云。後來她在裡面找到準備好的地圖，上面寫著距離還有三公里。',
      '守望者回覆了信差，重複確認復活儀式的時間。覆蓋祭壇的布已經恢復原狀，幹部們在門外乾杯，沒有人敢干涉。',
      '麵條涼了，他卻顧不了面子，鬱悶地望著山谷裡的穀物。製造這件法器的制度早已失傳，鐘樓的時鐘停在午夜。',
      '她鍾愛那把模範的長劍，範圍之內的黨派都對它虎視眈眈。優秀的工匠開出的價格異常昂貴，機關重重的密室裡，',
      '網路般的絲線纏住身體。頭髮蒼白的老人發現了蘋果樹下的祕密：據說只有確實離開這裡，才能適應外面的世界。',
      '請注意，這座村莊每年舉辦一次祭典，村民會在廣場上點燃營火，並且把乾燥的麥穗丟進火裡，祈求豐收與平安。',
      '調查員們決定先回旅館整理線索，再前往圖書館查閱舊報紙。圖書館員態度冷淡，卻仍然提供了三份泛黃的剪報。',
      '祂的低語穿過牆壁，牠們在地板下爬行，他與她互望一眼，它們卻沒有發出任何聲音。沒有人知道接下來會發生什麼事。',
      '手頭拮据的歌手夢想成為天后或影后，母后與帝后都不以為然，后妃們祭拜后土，頭戴后冠的新人封后之後，廢后獨居深宮。',
      '蟻后與蜂后統治巢穴，冥后、神后、魔后與妖后的傳說流傳已久，后稷教民稼穡，單于率軍越過于闐。党項人定居并州。',
      '老師說話不知所云，學生只會人云亦云，古人云詩云都背不熟，云爾而已。窗明几淨的書房裡，几案上放著万俟先生的叶韻字書。',
      '她從后里出發，經過后壁，再到后龍，一路上都在想這件事。',
    ].join('');
    expect(scriptViolations(profile.script_check, text)).toEqual([]);
    const source = 'x'.repeat(text.length);
    const verdict = verifyFragment(unit(source), `<s id="1">${text}</s>`, context());
    expect(codes(verdict)).toEqual([]);
  });
});

describe('length (ADR-0102)', () => {
  const source = 'a '.repeat(40);

  it('fails a translation that looks like a summary', () => {
    expect(codes(verifyFragment(unit(source), '<s id="1">摘要</s>', context()))).toEqual(['too_short']);
  });

  it('only reports one that runs long', () => {
    const verdict = verifyFragment(unit(source), `<s id="1">${'字'.repeat(61)}</s>`, context());
    expect(verdict.problems).toEqual([{ code: 'too_long', level: 'report' }]);
    expect(verdict.passed).toBe(true);
  });

  it('accepts the edges of the range', () => {
    expect(codes(verifyFragment(unit(source), `<s id="1">${'字'.repeat(8)}</s>`, context()))).toEqual([]);
    expect(codes(verifyFragment(unit(source), `<s id="1">${'字'.repeat(60)}</s>`, context()))).toEqual([]);
  });

  it('accepts a natural translation at 0.27, which the old floor of 0.3 sent back (ADR-0111)', () => {
    const long = 'a '.repeat(149);
    expect(codes(verifyFragment(unit(long), `<s id="1">${'字'.repeat(40)}</s>`, context()))).toEqual([]);
  });

  it('still sends back one that lost half its words, below 0.2 (ADR-0111)', () => {
    expect(codes(verifyFragment(unit(source), `<s id="1">${'字'.repeat(7)}</s>`, context()))).toEqual(['too_short']);
  });

  it('leaves short sources alone, since Yes may well become one character', () => {
    expect(codes(verifyFragment(unit('Yes.'), '<s id="1">是。</s>', context()))).toEqual([]);
  });

  it('counts letters only, so placeholders and punctuation do not pad it', () => {
    const masked = unit(`${'a '.repeat(40)}1D6`, [{ start: 80, end: 83, kind: 'dice' }]);
    const padded = `<s id="1">${'，'.repeat(50)}<ph id="1"/>${'。'.repeat(50)}</s>`;
    expect(codes(verifyFragment(masked, padded, context()))).toEqual(['too_short']);
  });
});

describe('the wording check, which only reports', () => {
  const phraseCheck: PhraseCheck = (text) => (text.includes('軟件') ? [{ term: '軟件', prefer: '軟體' }] : []);

  it('reports the word and what to use, and does not send it back', () => {
    const verdict = verifyFragment(unit(LONG_SOURCE), `<s id="1">${LONG_TRANSLATION}軟件</s>`, context({ phraseCheck }));
    expect(verdict.passed).toBe(true);
    expect(verdict.problems).toEqual([
      { code: 'term_suspect', level: 'report', detail: { term: '軟件', prefer: '軟體' } },
    ]);
  });

  it('reads the list in the language profile too', () => {
    const language = { ...profile, term_checks: [{ avoid: '地圖', prefer: '圖' }] };
    const verdict = verifyFragment(unit(LONG_SOURCE), `<s id="1">${LONG_TRANSLATION}地圖</s>`, context({ language }));
    expect(verdict.problems).toEqual([
      { code: 'term_suspect', level: 'report', detail: { term: '地圖', prefer: '圖' } },
    ]);
  });

  it('skips the exceptions', () => {
    const language = { ...profile, term_exceptions: ['軟件'], term_checks: [{ avoid: '軟件', prefer: '軟體' }] };
    const fragment = `<s id="1">${LONG_TRANSLATION}軟件</s>`;
    expect(codes(verifyFragment(unit(LONG_SOURCE), fragment, context({ language, phraseCheck })))).toEqual([]);
  });

  describe('with the real phrase table', () => {
    let real: PhraseCheck;

    beforeAll(async () => {
      real = await loadPhraseCheck(profile);
    }, 30_000);

    it('finds mainland wording and says what Taiwan uses', () => {
      const found = real('這套軟件的默認設置');
      expect(found.map(({ term: word }) => word)).toContain('軟件');
      expect(found.find(({ term: word }) => word === '軟件')?.prefer).toBe('軟體');
    });

    it('leaves plain Taiwan wording alone', () => {
      expect(real('調查員走進圖書館，向館員借閱舊報紙。')).toEqual([]);
    });

    it('does not flag variant characters, only phrases', () => {
      expect(real('裏面')).toEqual([]);
    });

    it('offers nothing when the language names no table', async () => {
      const { opencc: _unused, ...plain } = profile;
      expect((await loadPhraseCheck(plain))('軟件')).toEqual([]);
    });
  });
});

describe('pronouns against the entity card, which only reports (ADR-0123)', () => {
  const source = 'Mara draws the old sword and waits by the gate until dawn.';
  const card = (text: string, target: string, pronoun?: string): LocalizedTerm => ({
    text,
    term: { source: { en: text }, target },
    ...(pronoun === undefined ? {} : { attributes: { pronoun } }),
  });
  const mara = card('Mara', '瑪拉', '她');
  const check = (translation: string, terms: readonly LocalizedTerm[] = [mara], text = source) =>
    verifyFragment(unit(text), `<s id="1">${translation}</s>`, context({ terms }));

  it('reports another pronoun where the one card the unit hits wants its own, and does not send it back', () => {
    const verdict = check('瑪拉拔出他的舊劍，在城門邊等到天亮。');
    expect(verdict.passed).toBe(true);
    expect(verdict.problems).toEqual([
      { code: 'pronoun_mismatch', level: 'report', detail: { term: 'Mara', expected: '她', found: '他' } },
    ]);
    expect(check('瑪拉看見他與牠，在城門邊等到天亮。').problems[0]?.detail).toEqual({ term: 'Mara', expected: '她', found: '他 牠' });
  });

  it('says nothing when the card’s own pronoun is there, or no pronoun at all', () => {
    expect(codes(check('瑪拉把舊劍交給他，她在城門邊等到天亮。'))).toEqual([]);
    expect(codes(check('瑪拉拔出舊劍，在城門邊等到天亮。'))).toEqual([]);
  });

  it('takes out the exceptions and the plural forms first', () => {
    expect(codes(check('瑪拉和其他守衛在城門邊等到天亮。'))).toEqual([]);
    expect(codes(check('瑪拉看著他們在城門邊等到天亮。'))).toEqual([]);
  });

  it('takes out the targets of the terms the unit hits first', () => {
    const taga = card('Taga', '塔他', '她');
    expect(codes(check('塔他拔出舊劍，在城門邊等到天亮。', [taga], source.replace('Mara', 'Taga')))).toEqual([]);
  });

  it('does not judge two cards with pronouns, a card without one, or a unit with no card', () => {
    const tor = card('Tor', '托爾', '他');
    const both = 'Mara and Tor draw the old swords and wait by the gate until dawn.';
    expect(codes(check('瑪拉與托爾拔出他的舊劍，在城門邊等到天亮。', [mara, tor], both))).toEqual([]);
    expect(codes(check('瑪拉拔出他的舊劍，在城門邊等到天亮。', [card('Mara', '瑪拉')]))).toEqual([]);
    expect(codes(check('瑪拉拔出他的舊劍，在城門邊等到天亮。', []))).toEqual([]);
  });
});

describe('translationese, which only reports (ADR-0123)', () => {
  const check = (tail: string, language = profile) =>
    verifyFragment(unit(LONG_SOURCE), `<s id="1">${LONG_TRANSLATION}${tail}</s>`, context({ language }));

  it('reports a listed phrase and what to write instead, once per unit, and does not send it back', () => {
    const verdict = check('作為一個獵人，作為一個守衛');
    expect(verdict.passed).toBe(true);
    expect(verdict.problems).toEqual([{ code: 'translationese', level: 'report', detail: { text: '作為一個', prefer: '身為' } }]);
  });

  it('reports a pair in one sentence, with what lies between', () => {
    expect(check('他被巫師所詛咒').problems).toEqual([
      { code: 'translationese', level: 'report', detail: { text: '被巫師所', prefer: '拿掉「所」' } },
    ]);
  });

  it('leaves a pair that spans the end of a sentence or lies too far apart', () => {
    expect(codes(check('他被抓了。所幸無事'))).toEqual([]);
    expect(codes(check('他被抓了'))).toEqual([]);
    expect(codes(check(`被${'甲'.repeat(16)}所`))).toEqual([]);
    expect(check(`被${'甲'.repeat(15)}所`).problems[0]?.detail).toEqual({ text: `被${'甲'.repeat(15)}所`, prefer: '拿掉「所」' });
  });

  it('finds a pair at the very start of the translation', () => {
    const verdict = verifyFragment(unit(LONG_SOURCE), `<s id="1">被巫師所詛咒的人，${LONG_TRANSLATION}</s>`, context());
    expect(verdict.problems).toEqual([{ code: 'translationese', level: 'report', detail: { text: '被巫師所', prefer: '拿掉「所」' } }]);
  });

  it('tries each first half until one fits', () => {
    expect(check('被抓了。又被巫師所詛咒').problems[0]?.detail).toEqual({ text: '被巫師所', prefer: '拿掉「所」' });
  });

  it('takes out the exceptions first, and checks nothing when the language has no list', () => {
    const rules = profile.translationese;
    if (rules === undefined) throw new Error('zh-TW has a translationese list');
    expect(codes(check('作為一個獵人', { ...profile, translationese: { ...rules, exceptions: ['作為一個'] } }))).toEqual([]);
    const { translationese: _unused, ...plain } = profile;
    expect(codes(check('作為一個獵人', plain))).toEqual([]);
  });
});

describe('human translations (ADR-0126)', () => {
  const WARDEN = 'The Warden counts 3 tide stones before each crossing and marks a lantern.';
  const DICE = 'Roll 1D100, then rest for the whole night by the old ferry.';
  const dice = unit(DICE, [{ start: 5, end: 10, kind: 'dice' }]);
  const warden = context({ terms: [term('Warden', '看守人')] });
  // 簡體字用碼位寫，受版控的文字檔才不用開例外（ADR-0086）。
  const SOFT = String.fromCodePoint(0x8f6f);

  it('checks them with the rules of the model, and only reports what it finds', () => {
    expect(humanProblems(unit(WARDEN), `守望者${SOFT}。`, warden)).toEqual([
      { code: 'number_missing', level: 'report', detail: { numbers: '3' } },
      { code: 'term_missing', level: 'report', detail: { term: 'Warden', target: '看守人' } },
      { code: 'script_mixed', level: 'report', detail: { found: SOFT } },
      { code: 'too_short', level: 'report' },
    ]);
    expect(humanProblems(unit(WARDEN), '看守人在每次渡河前清點 3 顆潮石，並在提燈上做記號。', warden)).toEqual([]);
  });

  it('takes each masked text out once before counting numbers, and reports the masked text it cannot find', () => {
    expect(humanProblems(dice, '擲1D100，然後在老渡口過夜休息，等待天亮再出發。', context())).toEqual([]);
    expect(humanProblems(dice, '1D100 擲完，就在老渡口過夜休息，等待天亮再出發。', context())).toEqual([]);
    expect(humanProblems(dice, '擲骰子，然後在老渡口過夜休息，等待天亮再出發。', context())).toEqual([
      { code: 'placeholder_mismatch', level: 'report', detail: { missing: '1D100' } },
    ]);
    const twice = unit('Roll 1D100 and 1D100 again before the long night by the old ferry.', [
      { start: 5, end: 10, kind: 'dice' },
      { start: 15, end: 20, kind: 'dice' },
    ]);
    expect(humanProblems(twice, '擲1D100兩次，然後在老渡口過夜，等待天亮。', context())).toEqual([
      { code: 'placeholder_mismatch', level: 'report', detail: { missing: '1D100' } },
    ]);
    expect(humanProblems(twice, '擲兩次骰子，然後在老渡口過夜，等待天亮。', context())).toEqual([
      { code: 'placeholder_mismatch', level: 'report', detail: { missing: '1D100 1D100' } },
    ]);
    // 拿掉的地方留一個字元，兩邊的字不會接成鎖定譯名。
    const joined = unit('The Warden rolls 1D100 by the old ferry before the long night.', [{ start: 17, end: 22, kind: 'dice' }]);
    expect(humanProblems(joined, '看守1D100人在老渡口邊擲骰，等待漫長的夜晚過去。', warden).map(({ code }) => code)).toEqual(['term_missing']);
  });

  it('ignores the asterisks a reader writes for bold and italic', () => {
    const text = '**看**守人在每次渡河前清點 *3* 顆潮石，並在提燈上做記號。';
    expect(humanProblems(unit(WARDEN), text, warden)).toEqual([]);
  });

  it('reports every problem, whatever the reader wrote', () => {
    const piece = fc.constantFrom('看守人', '守望者', SOFT, '3', '1D100', '*', '，', '渡口', 'Warden', '作為一個');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), (pieces) => {
        const problems = humanProblems(dice, pieces.join(''), warden);
        expect(problems.every(({ level }) => level === 'report')).toBe(true);
      }),
    );
  });
});

describe('what the model flagged (ADR-0100)', () => {
  it('keeps new terms, and the translation stays in the text', () => {
    const fragment = `<s id="1">${LONG_TRANSLATION}<new-term source="Salt Marsh">鹽沼</new-term></s>`;
    const verdict = verifyFragment(unit(LONG_SOURCE), fragment, context());
    expect(verdict.problems).toEqual([
      { code: 'new_term', level: 'report', detail: { source: 'Salt Marsh', target: '鹽沼' } },
    ]);
    expect(verdict.translation).toBe(`${LONG_TRANSLATION}鹽沼`);
  });

  it('keeps untranslatable flags', () => {
    const fragment = `<s id="1">${LONG_TRANSLATION}<flag reason="藏頭詩">謎面</flag></s>`;
    const verdict = verifyFragment(unit(LONG_SOURCE), fragment, context());
    expect(verdict.problems).toEqual([
      { code: 'untranslatable', level: 'report', detail: { reason: '藏頭詩', text: '謎面' } },
    ]);
  });
});
