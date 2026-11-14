import { ALL_CARDS, type PageModel } from '../../src/cli/review/page.ts';
import type { ReviewCard } from '../../src/core/glossary.ts';

// 審定網頁逐字比對用的兩個頁面（`tests/cli/review-page.test.ts`）。卡片的文字是這裡編的。

const BASE: ReviewCard = {
  id: 0,
  source: '',
  target: null,
  class: null,
  gender: null,
  pronoun: null,
  register: null,
  keep_source: false,
  case_sensitive: true,
  whole_word: true,
  roles: [],
  count: 1,
  origin: 'pass0',
  decided_by: null,
  seen_in: [],
};

const CHOICES = { classes: ['person', 'place'], genders: ['female', 'male', 'none'], pronouns: ['她', '他'], roles: ['heading', 'paragraph'] };

/** 待審的分頁：一張填滿、驗證沒過的卡，一張什麼都沒填的卡，有提示。 */
const REVIEW: PageModel = {
  base: '/t0ken/',
  book: 'book',
  tab: 'review',
  cards: {
    review: [
      {
        ...BASE,
        id: 3,
        source: 'Grey <Warden>',
        target: '灰色守望者',
        class: 'person',
        gender: 'female',
        pronoun: '她',
        register: 'formal',
        keep_source: true,
        case_sensitive: false,
        roles: ['heading'],
        count: 6,
        origin: 'new_term',
        seen_in: ['The "Grey <Warden>" waits & watches.', 'She counts stones.'],
      },
      // 待審的分頁不印誰決定的，卡上有也不印。
      { ...BASE, id: 7, source: 'Harrow Gate', origin: 'import', decided_by: 'human' },
    ],
    locked: [{ ...BASE, id: 9, source: 'Old Ferry', target: '老渡口', decided_by: 'auto' }],
    skipped: [],
  },
  choices: CHOICES,
  view: ALL_CARDS,
  focus: 7,
  notice: '已鎖定 #1。',
  invalid: {
    id: 3,
    field: 'pronoun',
    input: { target: '灰衣', class: 'person', gender: 'male', pronoun: '祂', register: '', keep_source: false, case_sensitive: true, whole_word: false, roles: ['paragraph'] },
  },
};

/** 已鎖定的分頁，篩選條件都設了：兩張留下、一張被篩掉。 */
const LOCKED: PageModel = {
  base: '/t0ken/',
  book: 'book',
  tab: 'locked',
  cards: {
    review: [],
    locked: [
      { ...BASE, id: 9, source: 'Old Ferry', target: '老渡口', decided_by: 'human', origin: 'unknown', seen_in: ['At the Old Ferry.'] },
      { ...BASE, id: 10, source: 'Salt Marsh', target: '鹽沼', class: 'place', decided_by: 'import' },
      // 已鎖定、卻沒記誰決定的（照理不會有），只是不印那一項。
      { ...BASE, id: 12, source: 'Ferry Bell', target: '渡口鐘' },
    ],
    skipped: [{ ...BASE, id: 11, source: 'Each Night' }],
  },
  choices: CHOICES,
  view: { q: ' FERRY ', kind: '-', proposal: 'with' },
  focus: null,
  notice: null,
  invalid: null,
};

export const GOLDEN_MODELS: readonly PageModel[] = [REVIEW, LOCKED];
