const numBound = (s) => String.raw`(?<!\d)` + s + String.raw`(?!\d)`;

export const DEFAULT_BRIDGE_PORT = 8791;

export const MODE_LIMITS = {
  "flow-text-to-image": { maxInputImages: 0, maxOutputs: 4 },
  "flow-image-to-image": { maxInputImages: 10, maxOutputs: 4 },
  "flow-text-to-video": { maxInputImages: 0, maxOutputs: 4 },
  "flow-frame-to-video": { maxInputImages: 2, maxOutputs: 4 },
  "flow-ingredients-to-video": { maxInputImages: 7, maxOutputs: 4 },
  "flow-video-to-video": { maxInputImages: 1, maxOutputs: 4 },
  "flow-create-character": { maxInputImages: 0, maxOutputs: 1 },
  "flow-set-voice": { maxInputImages: 0, maxOutputs: 1 },
  "flow-extend-video": { maxInputImages: 0, maxOutputs: 1 },
  "flow-rename-asset": { maxInputImages: 1, maxOutputs: 1 },
  "flow-upload-assets": { maxInputImages: 500, maxOutputs: 1 }
};

const MODEL_INGREDIENT_CAPS = {
  "omni-flash": 7,
  "veo-3.1-quality": 0
};
const DEFAULT_VEO_INGREDIENTS = 3;

export function getMaxReferences(mode, model) {
  if (mode !== "flow-ingredients-to-video") {
    return MODE_LIMITS[mode]?.maxInputImages ?? 0;
  }
  return MODEL_INGREDIENT_CAPS[model ?? ""] ?? DEFAULT_VEO_INGREDIENTS;
}

export function isVideoGenerationMode(mode) {
  return typeof mode === "string" && mode.startsWith("flow-") && mode.endsWith("-to-video");
}

export const DEFAULT_TUNABLES = {
  stallMs: 120000,
  videoGraceMs: 4000,
  videoSettleMs: 8000,
  submitSettleMs: 3000,
  resultGraceMs: 3000,
  groupCollectMs: 1500,
  groupCollectMaxMs: 6000,
  upscaleTimeoutMs: 60000,
  videoUpscaleTimeoutMs: 300000,
  newRunGapMs: 300000
};

export const BUILTIN_SELECTORS = {
  promptInput: [
    { kind: "css", css: 'textarea[placeholder*="want to create" i]' },
    { kind: "css", css: 'div[contenteditable="true"][role="textbox"]' },
    { kind: "css", css: 'div[contenteditable="true"]' },
    { kind: "css", css: "textarea" }
  ],
  submitButton: [
    { kind: "text", text: "arrow_forward.*create", role: "button" },
    { kind: "aria", label: "generate", tag: "button" },
    { kind: "aria", label: "submit", tag: "button" },
    { kind: "aria", label: "send", tag: "button" },
    { kind: "css", css: 'button[type="submit"]' }
  ],
  settingsPanelOpen: [
    { kind: "css", css: 'flow-toggles[aria-label="Mode"]' },
    { kind: "css", css: ".cdk-overlay-pane flow-toggles" },
    { kind: "css", css: '[role="radiogroup"] button[role="radio"]' }
  ],
  attachButton: [
    { kind: "css", css: 'button[aria-label="Add ingredients to the prompt box"]' },
    { kind: "css", css: 'button[aria-label="Add media menu"]' },
    { kind: "css", css: 'button[aria-haspopup="dialog"][aria-controls^="radix-"]' },
    { kind: "css", css: 'button[aria-haspopup="dialog"]' },
    { kind: "text", text: "add_2.*create", role: "button" },
    { kind: "text", text: "^add$", tag: 'button[aria-haspopup="true"]' }
  ],
  fileInput: [{ kind: "css", css: 'input[type="file"]', hidden: true }],
  assetFilterTrigger: [{ kind: "css", css: 'button[aria-label="Filter by category"]' }],
  assetFilterAll: [{ kind: "text", text: "^dashboards*all$", role: "option" }],
  parkedFileInput: [{ kind: "css", css: "input[data-mflow-parked]", hidden: true }],
  frameSlotStart: [
    { kind: "text", text: "^start$" },
    { kind: "aria", label: "start frame" },
    { kind: "css", css: ".ingredient-bar-container > div.frame-trigger:first-of-type > button" }
  ],
  frameSlotEnd: [
    { kind: "text", text: "^end$" },
    { kind: "aria", label: "end frame" },
    { kind: "css", css: ".ingredient-bar-container > div.frame-trigger:last-of-type > button" }
  ],
  assetSearchInput: [
    { kind: "css", css: "#add-menu-input" },
    { kind: "css", css: 'input[placeholder*="search asset" i]' },
    { kind: "aria", label: "search assets", tag: "input" }
  ],
  addToPromptButton: [
    { kind: "text", text: "add to prompt", role: "button" },
    { kind: "aria", label: "add to prompt" },
    { kind: "text", text: "add to prompt" }
  ],
  promptReferenceRemove: [
    { kind: "text", text: "^cancel", role: "button" },
    { kind: "css", css: "flow-ingredient-bar .ingredient-bar-container button.chip-container" }
  ],
  uploadMediaButton: [
    { kind: "css", css: 'button[aria-label="Upload media"]' },
    { kind: "css", css: 'button[aria-label="Upload"]' },
    { kind: "css", css: "button.upload-button" },
    { kind: "text", text: "^upload\\s*upload$", role: "button" },
    { kind: "text", text: "^upload\\s*upload$" },
    { kind: "text", text: "upload media", role: "button" },
    { kind: "aria", label: "upload media" },
    { kind: "aria", label: "^upload$" },
    { kind: "text", text: "upload media" },
    { kind: "text", text: "^upload$", role: "button" }
  ],
  tabImage: [
    { kind: "text", text: "^image\\s*image$", role: "radio" },
    { kind: "text", text: "^image\\s*image$", role: "tab" }
  ],
  tabVideo: [
    { kind: "text", text: "^videocam\\s*video$", role: "radio" },
    { kind: "text", text: "^videocam\\s*video$", role: "tab" },
    { kind: "text", text: "^videocam\\s*\\S", role: "radio" },
    { kind: "text", text: "^videocam\\s*\\S", role: "tab" }
  ],
  tabFrames: [
    { kind: "text", text: "^crop_free\\s*frames$", role: "radio" },
    { kind: "text", text: "^crop_free\\s*frames$", role: "tab" },
    { kind: "text", text: "^crop_free\\s*\\S", role: "radio" },
    { kind: "text", text: "^crop_free\\s*\\S", role: "tab" }
  ],
  tabIngredients: [
    { kind: "text", text: "^chrome_extension\\s*ingredients$", role: "radio" },
    { kind: "text", text: "^chrome_extension\\s*ingredients$", role: "tab" },
    { kind: "text", text: "^chrome_extension\\s*\\S", role: "radio" },
    { kind: "text", text: "^chrome_extension\\s*\\S", role: "tab" }
  ],
  durationChip_4s: [
    { kind: "text", text: "^\\s*4s\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*4s\\s*$", role: "tab" }
  ],
  durationChip_6s: [
    { kind: "text", text: "^\\s*6s\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*6s\\s*$", role: "tab" }
  ],
  durationChip_8s: [
    { kind: "text", text: "^\\s*8s\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*8s\\s*$", role: "tab" }
  ],
  durationChip_10s: [
    { kind: "text", text: "^\\s*10s\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*10s\\s*$", role: "tab" }
  ],
  clipEditorDone: [
    { kind: "text", text: "^\\s*done\\s*$", role: "button" },
    { kind: "aria", label: "^done$" }
  ],
  resolutionChip_360p: [
    { kind: "text", text: "^\\s*360p\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*360p\\s*$", role: "tab" }
  ],
  resolutionChip_720p: [
    { kind: "text", text: "^\\s*720p\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*720p\\s*$", role: "tab" }
  ],
  modelOption_omniFlash: [
    { kind: "text", text: "omni\\b.*\\bflash$" },
    { kind: "text", text: "omni flash$" }
  ],
  modelOption_veo31Lite: [{ kind: "text", text: "veo 3\\.1\\s*-?\\s*lite$" }],
  modelOption_veo31Fast: [{ kind: "text", text: "veo 3\\.1\\s*-?\\s*fast$" }],
  modelOption_veo31Quality: [{ kind: "text", text: "veo 3\\.1\\s*-?\\s*quality$" }],
  settingsPill: [
    { kind: "text", text: "crop_.*x[1-9]", role: "button" },
    { kind: "aria", label: "model" }
  ],
  modelPill: [{ kind: "text", text: "arrow_drop_down$", role: "button" }],
  modelOption_nanoBananaPro: [
    { kind: "text", text: "^[^a-z]*nano banana pro[^a-z]*$", role: "menuitem" },
    { kind: "text", text: "^[^a-z]*nano banana pro[^a-z]*$", role: "option" },
    { kind: "text", text: "^[^a-z]*nano banana pro[^a-z]*$" }
  ],
  modelOption_nanoBanana2: [
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*$", role: "menuitem" },
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*$", role: "option" },
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*$" }
  ],
  modelOption_nanoBanana2Lite: [
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*lite[^a-z]*$", role: "menuitem" },
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*lite[^a-z]*$", role: "option" },
    { kind: "text", text: "^[^a-z]*nano banana 2[^a-z]*lite[^a-z]*$" }
  ],
  aspectOption_16_9: [
    { kind: "text", text: numBound("16:9"), role: "radio" },
    { kind: "text", text: numBound("16:9"), role: "tab" },
    { kind: "text", text: numBound("16:9") },
    { kind: "aria", label: "16:9", tag: "button" }
  ],
  aspectOption_4_3: [
    { kind: "text", text: numBound("4:3"), role: "radio" },
    { kind: "text", text: numBound("4:3"), role: "tab" },
    { kind: "text", text: numBound("4:3") },
    { kind: "aria", label: "4:3", tag: "button" }
  ],
  aspectOption_1_1: [
    { kind: "text", text: numBound("1:1"), role: "radio" },
    { kind: "text", text: numBound("1:1"), role: "tab" },
    { kind: "text", text: numBound("1:1") },
    { kind: "aria", label: "1:1", tag: "button" }
  ],
  aspectOption_3_4: [
    { kind: "text", text: numBound("3:4"), role: "radio" },
    { kind: "text", text: numBound("3:4"), role: "tab" },
    { kind: "text", text: numBound("3:4") },
    { kind: "aria", label: "3:4", tag: "button" }
  ],
  aspectOption_9_16: [
    { kind: "text", text: numBound("9:16"), role: "radio" },
    { kind: "text", text: numBound("9:16"), role: "tab" },
    { kind: "text", text: numBound("9:16") },
    { kind: "aria", label: "9:16", tag: "button" }
  ],
  outputCountChip_1: [
    { kind: "text", text: "^\\s*x1\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*x1\\s*$", role: "tab" },
    { kind: "text", text: "^\\s*x1\\s*$", role: "button" }
  ],
  outputCountChip_2: [
    { kind: "text", text: "^\\s*x2\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*x2\\s*$", role: "tab" },
    { kind: "text", text: "^\\s*x2\\s*$", role: "button" }
  ],
  outputCountChip_3: [
    { kind: "text", text: "^\\s*x3\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*x3\\s*$", role: "tab" },
    { kind: "text", text: "^\\s*x3\\s*$", role: "button" }
  ],
  outputCountChip_4: [
    { kind: "text", text: "^\\s*x4\\s*$", role: "radio" },
    { kind: "text", text: "^\\s*x4\\s*$", role: "tab" },
    { kind: "text", text: "^\\s*x4\\s*$", role: "button" }
  ],
  resultImage: [
    { kind: "css", css: "flow-image-tile img[data-media-id]" },
    { kind: "css", css: "img[data-media-id][src*='flow-content.google']" },
    { kind: "css", css: "img[src*='media.getMediaUrlRedirect']" },
    { kind: "css", css: "img[src*='/generated/']" },
    { kind: "css", css: "img[src^='blob:']" },
    { kind: "css", css: 'div[role="listitem"] img' }
  ],
  resultVideo: [
    { kind: "css", css: "flow-video-tile img.thumbnail" },
    { kind: "css", css: "flow-video-tile img" },
    { kind: "css", css: "video[src*='flow-content.google']", hidden: true },
    { kind: "css", css: "video source[src*='flow-content.google']", hidden: true },
    { kind: "css", css: "video[src*='media.getMediaUrlRedirect']", hidden: true },
    { kind: "css", css: "video[src]", hidden: true },
    { kind: "css", css: "video source[src]", hidden: true }
  ],
  progressIndicator: [
    { kind: "css", css: "div.animate-spin" },
    { kind: "css", css: "[class*='progress'], [role='progressbar']" },
    { kind: "css", css: "[class*='shimmer'], [class*='skeleton'], [class*='animate-pulse']" },
    { kind: "text", text: "(generating|creating)(\\.\\.\\.|…|\\s*\\d+%)" }
  ],
  usageLimitToast: [
    { kind: "text", text: "reached your (usage|daily) limit" },
    { kind: "text", text: "usage limit" },
    { kind: "text", text: "you.{0,3}ve reached" }
  ],
  moderationToast: [
    { kind: "text", text: "content (policy|moderat)|blocked|violat|unable to generate|can.?t generate" },
    { kind: "css", css: "[role='alert']:not(#__next-route-announcer__)" }
  ],
  uploadErrorToast: [
    { kind: "text", text: "failed to load|upload failed|failed to upload|couldn.?t upload|could not upload" }
  ],
  unusualActivityToast: [
    {
      kind: "text",
      text: "unusual activity|try again later|suspicious activity|automated (traffic|requests)|unusual traffic|rate limit",
      role: "alert"
    },
    { kind: "css", css: "[role='alert']:not(#__next-route-announcer__)" },
    { kind: "css", css: "[role='dialog']" }
  ],
  downloadButton: [
    { kind: "aria", label: "download" },
    { kind: "text", text: "download", role: "menuitem" },
    { kind: "css", css: "a[download]" }
  ],
  qualityOption_1k: [{ kind: "text", text: "^1k", role: "menuitem" }],
  qualityOption_2k: [{ kind: "text", text: "^2k", role: "menuitem" }],
  qualityOption_4k: [{ kind: "text", text: "^4k", role: "menuitem" }],
  qualityOption_1080p: [{ kind: "text", text: "^1080p", role: "menuitem" }],
  assetMenuTrigger: [
    { kind: "css", css: 'button[aria-label="More options"]' },
    { kind: "css", css: 'button[aria-haspopup="menu"]' }
  ],
  renameMenuItem: [
    { kind: "text", text: "^edits*rename$", role: "button" },
    { kind: "text", text: "^s*renames*$", role: "menuitem" },
    { kind: "text", text: "rename$", role: "button" }
  ],
  renameInput: [
    { kind: "css", css: 'textarea[aria-label="Rename tile"]' },
    { kind: "aria", label: "rename tile", tag: "textarea" },
    { kind: "aria", label: "rename" },
    { kind: "css", css: "textarea" }
  ],
  renameConfirmButton: [
    { kind: "text", text: "^done$", role: "button" },
    { kind: "text", text: "^(save|rename|ok|confirm)$", role: "button" }
  ],
  sidebarCharacters: [
    { kind: "text", text: "accessibility_new\\s*characters", tag: "mat-list-item" },
    { kind: "text", text: "^accessibility_new\\s*characters$" },
    { kind: "text", text: "accessibility_new\\s*characters", role: "button" }
  ],
  addMediaMenuButton: [
    { kind: "css", css: 'button[aria-label="Add media menu"]' },
    { kind: "aria", label: "add media menu" }
  ],
  menuCreateCharacter: [
    { kind: "text", text: "account_circle\\s*create character", role: "button" },
    { kind: "text", text: "^create character$" }
  ],
  newCharacterTile: [{ kind: "text", text: "^add\\s*new character$" }],
  characterNameInput: [
    { kind: "css", css: 'input[placeholder*="character name" i]' },
    { kind: "aria", label: "character name", tag: "input" }
  ],
  characterDoneButton: [
    { kind: "css", css: 'button[aria-label="Finished editing"]' },
    { kind: "aria", label: "finished editing" },
    { kind: "text", text: "^finished\\s*editing$", role: "button" },
    { kind: "css", css: 'button[aria-label="Done editing"]' },
    { kind: "aria", label: "done editing" },
    { kind: "text", text: "^done$", role: "button" }
  ],
  editorBackButton: [
    { kind: "css", css: 'button[aria-label="Go back"]' },
    { kind: "text", text: "^arrow_back\\s*back$", role: "button" }
  ],
  characterEditPage: [{ kind: "css", css: "flow-character-edit-page" }],
  characterModelButton: [
    { kind: "css", css: 'button[aria-label="Select model family"]' },
    { kind: "aria", label: "select model family" }
  ],
  characterInfoInput: [
    { kind: "css", css: 'textarea[placeholder*="how your character acts" i]' },
    { kind: "css", css: 'textarea[placeholder*="character acts" i]' }
  ],
  selectVoiceButton: [
    { kind: "text", text: "voice_selection\\s*select a voice", role: "button" }
  ],
  createBodyButton: [
    { kind: "text", text: "accessibility_new\\s*create body", role: "button" },
    { kind: "aria", label: "create body" },
    { kind: "text", text: "^create body$", role: "button" }
  ],
  voiceSearchInput: [
    { kind: "css", css: "#add-menu-input" },
    { kind: "css", css: 'input[placeholder*="search asset" i]' },
    { kind: "css", css: 'input[placeholder*="search" i]' }
  ],
  voiceStyleInput: [
    { kind: "css", css: 'textarea[placeholder*="voice performance style" i]' },
    { kind: "css", css: 'textarea[placeholder*="performance style" i]' },
    { kind: "css", css: `textarea[placeholder*="how your character's voice sounds" i]` },
    { kind: "css", css: 'textarea[placeholder*="voice sounds" i]' }
  ],
  voiceNameInput: [
    { kind: "css", css: 'input[placeholder*="voice name" i]' },
    { kind: "css", css: 'textarea[placeholder*="voice name" i]' },
    { kind: "css", css: 'textarea[placeholder*="custom voice" i]' },
    { kind: "css", css: 'input[placeholder*="custom voice" i]' }
  ],
  saveNewVoiceButton: [{ kind: "text", text: "save new voice", role: "button" }],
  voiceResetButton: [{ kind: "text", text: "^restart_alt\\s*reset$", role: "button" }],
  addToCharacterButton: [
    { kind: "text", text: "^add to character$", role: "button" },
    { kind: "text", text: "add to character" }
  ],
  voiceRemoveButton: [{ kind: "text", text: "^remove$", role: "button" }],
  extendTrigger: [
    { kind: "css", css: 'button[data-add-button="true"]' },
    { kind: "text", text: "^add\\s*add clip$", role: "button" }
  ],
  extendMenuItem: [{ kind: "text", text: "extend \\(", role: "menuitem" }],
  extendModeIndicator: [
    { kind: "text", text: "what happens next" },
    { kind: "text", text: "prompt to extend" }
  ],
  newProjectButton: [
    { kind: "css", css: "button.new-project-button" },
    { kind: "text", text: "^add(?:_2)?s*new project$", role: "button" }
  ],
  loginIndicator: [
    { kind: "text", text: "^\\s*(sign in|log in)\\s*$", role: "button" },
    { kind: "css", css: "a[href*='accounts.google.com/ServiceLogin'], a[href*='accounts.google.com/signin']" }
  ]
};

const OVERRIDE_KEY = "mflow:customSelectors";
let customSelectors = null;
let customTunables = {};

export function getTunable(key, fallback) {
  const val = customTunables[key] ?? DEFAULT_TUNABLES[key];
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

export function getSelectors() {
  return customSelectors ? { ...BUILTIN_SELECTORS, ...customSelectors } : BUILTIN_SELECTORS;
}

export async function loadSelectorOverrides() {
  try {
    const res = await chrome.storage.local.get(OVERRIDE_KEY);
    const data = res[OVERRIDE_KEY];
    if (data && typeof data === "object") {
      customSelectors = data.selectors ?? null;
      customTunables = data.tunables ?? {};
    }
  } catch {
    // Ignore
  }
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[OVERRIDE_KEY]) {
      const next = changes[OVERRIDE_KEY].newValue;
      customSelectors = next?.selectors ?? null;
      customTunables = next?.tunables ?? {};
    }
  });
}

