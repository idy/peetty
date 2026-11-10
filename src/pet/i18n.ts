export type Language = 'en' | 'zh';

const TEXT = {
  en: {
    greet: 'Say hi',
    chat: 'Chat',
    configure: 'Settings',
    pet: 'Peetty. Double-click to chat; right-click for actions.',
    chatFailed: 'Chat could not load. Please try again.',
    move: 'Somewhere else',
    nap: 'Take a nap',
    sound: 'Sound: off',
    soundOn: 'Sound: on',
    soundLabel: 'Sound effects',
    hide: 'Hide',
    menu: 'Peetty actions',
    hello: ['Hi there!', 'What are you reading?', "I'm right here.", 'Hello again!'],
    moved: ["Oops, I'll move.", 'Your turn to type!'],
  },
  zh: {
    greet: '打招呼',
    chat: '聊天',
    configure: '配置',
    pet: 'Peetty。双击聊天，右键打开操作菜单。',
    chatFailed: '聊天暂时没有加载成功，请再试一次。',
    move: '换个地方',
    nap: '打个盹',
    sound: '音效：关',
    soundOn: '音效：开',
    soundLabel: '音效',
    hide: '先藏起来',
    menu: 'Peetty 操作',
    hello: ['你好呀～', '在看什么呢？', '我在这儿陪你。', '又见面啦！'],
    moved: ['哎呀，我让开～', '你先打字！'],
  },
} as const;

export type Strings = (typeof TEXT)[Language];

export function languageOf(preference: Language | 'auto' = 'auto'): Language {
  if (preference !== 'auto') return preference;
  const locales = globalThis.navigator?.languages ?? [globalThis.navigator?.language ?? 'en'];
  for (const locale of locales) {
    const primary = locale.toLowerCase().split(/[-_]/)[0];
    if (primary === 'zh' || primary === 'en') return primary;
  }
  return 'en';
}

export function strings(language: Language): Strings {
  return TEXT[language];
}
