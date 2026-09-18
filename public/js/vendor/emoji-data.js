// ============================================================
// Wire Emoji Data Adapter
// ------------------------------------------------------------
// Adapts @emoji-mart/data to the data shape expected by the
// existing Wire emoji picker.
//
// @emoji-mart/data structure:
//
// data.categories:
//   [
//     {
//       id: 'people',
//       emojis: ['grinning', 'smiley', ...]
//     }
//   ]
//
// data.emojis:
//   {
//     grinning: {
//       id: 'grinning',
//       name: 'Grinning Face',
//       keywords: [...],
//       skins: [
//         { unified: '1f600', native: '😀' }
//       ]
//     }
//   }
// ============================================================

import data from './emoji-mart-data.js';

// ------------------------------------------------------------
// Category configuration
// ------------------------------------------------------------

const CATEGORY_CONFIG = [
  {
    id: 'people',
    sourceId: 'people',
    name: 'Smileys & People',
    icon: '😀'
  },
  {
    id: 'nature',
    sourceId: 'nature',
    name: 'Animals & Nature',
    icon: '🐻'
  },
  {
    id: 'food',
    sourceId: 'foods',
    name: 'Food & Drink',
    icon: '🍔'
  },
  {
    id: 'activity',
    sourceId: 'activity',
    name: 'Activities',
    icon: '⚽'
  },
  {
    id: 'travel',
    sourceId: 'places',
    name: 'Travel & Places',
    icon: '🚗'
  },
  {
    id: 'objects',
    sourceId: 'objects',
    name: 'Objects',
    icon: '💡'
  },
  {
    id: 'symbols',
    sourceId: 'symbols',
    name: 'Symbols',
    icon: '❤️'
  },
  {
    id: 'flags',
    sourceId: 'flags',
    name: 'Flags',
    icon: '🏳️'
  }
];

// ------------------------------------------------------------
// Source indexes
// ------------------------------------------------------------

const sourceCategories = new Map(
  Array.isArray(data?.categories)
    ? data.categories.map(category => [
        category.id,
        category
      ])
    : []
);

const sourceEmojis =
  data?.emojis &&
  typeof data.emojis === 'object'
    ? data.emojis
    : {};

// ------------------------------------------------------------
// Public categories
// ------------------------------------------------------------

export const CATEGORIES = CATEGORY_CONFIG.filter(category =>
  sourceCategories.has(category.sourceId)
);

// ------------------------------------------------------------
// Public emoji list
// ------------------------------------------------------------

export const EMOJI = CATEGORIES.flatMap(category => {
  const sourceCategory = sourceCategories.get(category.sourceId);

  if (!sourceCategory || !Array.isArray(sourceCategory.emojis)) {
    return [];
  }

  return sourceCategory.emojis
    .map(id => {
      const emoji = sourceEmojis[id];

      if (!emoji || typeof emoji !== 'object') {
        return null;
      }

      const skins = Array.isArray(emoji.skins)
        ? emoji.skins
        : [];

      const native =
        skins[0]?.native ||
        '';

      if (!native) {
        return null;
      }

      const keywords = [
        ...(Array.isArray(emoji.keywords)
          ? emoji.keywords
          : []),

        ...(Array.isArray(emoji.emoticons)
          ? emoji.emoticons
          : [])
      ];

      return {
        id: emoji.id || id,

        name:
          emoji.name ||
          id,

        cat:
          category.id,

        char:
          native,

        kw:
          keywords
            .join(' ')
            .toLowerCase(),

        // More than one skin means the emoji supports
        // skin-tone variants.
        skin:
          skins.length > 1,

        // Keep the original Emoji Mart skin objects.
        skins
      };
    })
    .filter(Boolean);
});

// ------------------------------------------------------------
// Skin tone modifiers
// ------------------------------------------------------------

export const SKIN_TONE_MODIFIERS = [
  '',
  '🏻',
  '🏼',
  '🏽',
  '🏾',
  '🏿'
];

// ------------------------------------------------------------
// Diagnostics
// ------------------------------------------------------------

console.debug('[Emoji] Loaded Emoji Mart data:', {
  categories: CATEGORIES.length,
  emojis: EMOJI.length,
  firstCategory: CATEGORIES[0]?.id || null,
  firstEmoji: EMOJI[0]?.id || null,
  firstEmojiChar: EMOJI[0]?.char || null
});